/**
 * The retry decision behind `agentsearch`. These endpoints expose no
 * idempotency key, so the property under test is narrow and expensive to get
 * wrong: a request that may already have been served is NEVER re-sent, and only
 * a proven-unserved failure (a connect fault or a 429) is retried.
 *
 * Every case injects `fetch`, the clock, and the backoff, so nothing sleeps and
 * nothing reaches the network.
 */

import { describe, expect, test } from "bun:test";
import {
  isConnectFailure,
  MAX_ATTEMPTS,
  postJson,
  RETRY_BACKOFF_MS,
  retryAfterMs,
  type TransportDeps,
} from "../src/transport";

const SPEC = {
  url: "https://api.example.invalid/x",
  apiKey: "k",
  body: { a: 1 },
  timeoutMs: 1_000,
};

/** A deps bundle whose sleep resolves instantly and records what was asked for. */
function deps(
  fetchImpl: typeof fetch,
  sleeps: number[] = [],
): TransportDeps & { sleeps: number[] } {
  let tick = 0;
  return {
    fetch: fetchImpl,
    now: () => {
      tick += 5;
      return tick;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    sleeps,
  };
}

function jsonResponse(
  status: number,
  body = "{}",
  headers?: Record<string, string>,
) {
  return new Response(body, { status, headers });
}

describe("isConnectFailure", () => {
  test("recognizes a refused connect", () => {
    const err = new Error("connect ECONNREFUSED 1.2.3.4:443");
    expect(isConnectFailure(err)).toBe(true);
  });

  test("recognizes a DNS miss carried on the cause", () => {
    const err = new Error("fetch failed");
    (err as { cause?: unknown }).cause = new Error("getaddrinfo ENOTFOUND api");
    expect(isConnectFailure(err)).toBe(true);
  });

  test("an abort is NOT a connect failure — the request was already sent", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(isConnectFailure(err)).toBe(false);
  });

  test("an unrecognized failure is not claimed as a connect failure", () => {
    expect(isConnectFailure(new Error("something odd happened"))).toBe(false);
  });
});

describe("retryAfterMs", () => {
  test("falls back to the fixed backoff without a header", () => {
    expect(retryAfterMs(null)).toBe(RETRY_BACKOFF_MS);
  });

  test("honors a seconds value", () => {
    expect(retryAfterMs("2")).toBe(2_000);
  });

  test("clamps an unreasonable wait", () => {
    expect(retryAfterMs("3600")).toBe(10_000);
  });

  test("ignores a malformed header", () => {
    expect(retryAfterMs("soon")).toBe(RETRY_BACKOFF_MS);
  });
});

describe("postJson", () => {
  test("sends the bearer token and the JSON body once on success", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse(200, '{"ok":true}');
    }) as unknown as typeof fetch;
    const outcome = await postJson(SPEC, deps(impl));
    expect(outcome.kind).toBe("response");
    expect(outcome.attempts).toBe(1);
    expect(seen).toHaveLength(1);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
    expect(seen[0]?.init.body).toBe(JSON.stringify(SPEC.body));
  });

  test("retries a clean connect failure exactly once", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("connect ECONNREFUSED 1.2.3.4:443");
      return jsonResponse(200);
    }) as unknown as typeof fetch;
    const outcome = await postJson(SPEC, deps(impl));
    expect(calls).toBe(2);
    expect(outcome.kind).toBe("response");
    expect(outcome.attempts).toBe(2);
  });

  test("retries a 429, honoring its Retry-After", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, "{}", { "retry-after": "2" })
        : jsonResponse(200);
    }) as unknown as typeof fetch;
    const outcome = await postJson(SPEC, deps(impl, sleeps));
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2_000]);
    expect(outcome.kind).toBe("response");
  });

  test("NEVER retries an ambiguous failure — a retry could bill twice", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const outcome = await postJson(SPEC, deps(impl));
    expect(calls).toBe(1);
    expect(outcome.kind).toBe("ambiguous");
  });

  test("NEVER retries a non-429 error status", async () => {
    for (const status of [400, 401, 403, 500, 503]) {
      let calls = 0;
      const impl = (async () => {
        calls += 1;
        return jsonResponse(status);
      }) as unknown as typeof fetch;
      const outcome = await postJson(SPEC, deps(impl));
      expect(calls).toBe(1);
      expect(outcome.kind).toBe("response");
    }
  });

  test("gives up after the attempt ceiling rather than hammering", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      throw new Error("connect ECONNREFUSED 1.2.3.4:443");
    }) as unknown as typeof fetch;
    const outcome = await postJson(SPEC, deps(impl));
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(outcome.kind).toBe("connect_failed");
  });
});
