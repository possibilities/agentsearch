/**
 * The paid POST behind `agentsearch`, and the one decision that keeps a retry
 * from double-spending.
 *
 * These endpoints expose no idempotency key, so a retried POST that the provider
 * already accepted is charged twice. The outcome is therefore classified into
 * three buckets, and only two of them are ever retried:
 *
 *   - `response`      — the provider answered with an HTTP status. Retried ONLY
 *                       on 429 (rate-limited, so the request was never served).
 *   - `connect_failed` — the request never reached the provider (refused, DNS,
 *                       unreachable). Retry-safe, and the caller may release its
 *                       budget hold: nothing was charged.
 *   - `ambiguous`     — anything else, including an abort/deadline after the
 *                       body was sent. NEVER retried, and the caller KEEPS its
 *                       budget hold: the request may have been served and billed.
 *
 * Unrecognized failures fall into `ambiguous` deliberately. Misreading an
 * accepted request as a connect failure costs real money twice; misreading a
 * connect failure as ambiguous costs one held reservation that ages out of the
 * rolling window.
 */

/** The three outcome classes. `latencyMs` is measured across every attempt so
 *  the ledger records the wall time the caller actually waited. */
export type TransportOutcome =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: string;
      readonly latencyMs: number;
      readonly attempts: number;
    }
  | {
      readonly kind: "connect_failed";
      readonly message: string;
      readonly latencyMs: number;
      readonly attempts: number;
    }
  | {
      readonly kind: "ambiguous";
      readonly message: string;
      readonly latencyMs: number;
      readonly attempts: number;
    };

export interface PostSpec {
  readonly url: string;
  readonly apiKey: string;
  readonly body: unknown;
  readonly timeoutMs: number;
}

export interface TransportDeps {
  /** HTTP seam (tests inject a stub; production uses the global). */
  readonly fetch?: typeof fetch;
  /** Monotonic-enough clock for latency (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Backoff seam so a test never sleeps. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Total attempts, including the first. One retry is enough to ride out a
 *  refused connect or a single rate-limit; more turns a paid endpoint into a
 *  hammer. */
export const MAX_ATTEMPTS = 2;

/** Backoff before the one retry. */
export const RETRY_BACKOFF_MS = 750;

/** Ceiling honored when the provider sends a `Retry-After` seconds value; a
 *  longer wait is the caller's to schedule, not ours to block on. */
export const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Error fingerprints that prove the request never left the client. Kept
 * deliberately tight — every unlisted failure is treated as ambiguous, which is
 * the safe side of the double-spend question.
 */
const CONNECT_FINGERPRINTS = [
  "econnrefused",
  "enotfound",
  "eai_again",
  "ehostunreach",
  "enetunreach",
  "enetdown",
  "connectionrefused",
  "failedtoopensocket",
  "unable to connect",
  "was not found by dns",
];

/** True when the thrown error names a pre-send connect failure. */
export function isConnectFailure(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") parts.push(code);
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      parts.push(cause.name, cause.message);
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeCode === "string") parts.push(causeCode);
    }
  } else {
    parts.push(String(error));
  }
  const haystack = parts.join(" ").toLowerCase();
  if (haystack.includes("abort") || haystack.includes("timeout")) return false;
  return CONNECT_FINGERPRINTS.some((f) => haystack.includes(f));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The retry delay a 429 asks for, clamped, or the fixed backoff when the
 *  provider named none. */
export function retryAfterMs(header: string | null): number {
  if (header === null) return RETRY_BACKOFF_MS;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return RETRY_BACKOFF_MS;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

async function attempt(
  spec: PostSpec,
  doFetch: typeof fetch,
): Promise<
  | {
      kind: "response";
      status: number;
      body: string;
      retryAfter: string | null;
    }
  | { kind: "connect_failed"; message: string }
  | { kind: "ambiguous"; message: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
  try {
    const response = await doFetch(spec.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${spec.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(spec.body),
      signal: controller.signal,
    });
    // A read failure AFTER the headers landed is ambiguous, not a connect
    // failure: the provider already accepted and may already have billed.
    const body = await response.text();
    return {
      kind: "response",
      status: response.status,
      body,
      retryAfter: response.headers.get("retry-after"),
    };
  } catch (error) {
    return isConnectFailure(error)
      ? { kind: "connect_failed", message: errorMessage(error) }
      : { kind: "ambiguous", message: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST one JSON body and classify the outcome. Retries a connect failure and a
 * 429 exactly once; every other outcome — including any other non-2xx status —
 * returns on the first attempt, because the request was already served.
 */
export async function postJson(
  spec: PostSpec,
  deps: TransportDeps = {},
): Promise<TransportOutcome> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = now();

  let attempts = 0;
  let last: Awaited<ReturnType<typeof attempt>> | null = null;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    last = await attempt(spec, doFetch);
    const retryable =
      last.kind === "connect_failed" ||
      (last.kind === "response" && last.status === 429);
    if (!retryable || attempts >= MAX_ATTEMPTS) break;
    await sleep(
      last.kind === "response"
        ? retryAfterMs(last.retryAfter)
        : RETRY_BACKOFF_MS,
    );
  }

  const latencyMs = Math.max(0, now() - started);
  if (last === null) {
    return {
      kind: "ambiguous",
      message: "no attempt was made",
      latencyMs,
      attempts,
    };
  }
  if (last.kind === "response") {
    return {
      kind: "response",
      status: last.status,
      body: last.body,
      latencyMs,
      attempts,
    };
  }
  return { kind: last.kind, message: last.message, latencyMs, attempts };
}
