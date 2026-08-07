/**
 * The `agentsearch` leaf: argument grammar, the cost guardrails, and the
 * envelope every outcome lands on.
 *
 * The whole flow is driven through injected deps — env, transport, and the two
 * ledger seams — so a case that asserts "the paid request was not sent" proves
 * it by counting calls, and no case reaches the network, the real ledger, or the
 * wall clock.
 */

import { describe, expect, test } from "bun:test";
import {
  AGENT_HELP,
  HELP,
  MAX_FIND_LIMIT,
  type ParsedSearch,
  parseSearchArgs,
  type RunSearchDeps,
  runSearchCommand,
  SEARCH_SCHEMA_VERSION,
} from "../cli/agentsearch";
import { NATIVE_COMMANDS, parseOptions } from "../cli/descriptor";
import type { reserveSpend, settleSpend } from "../src/ledger";
import {
  AGENT_ENDPOINT,
  DEFAULT_SEARCH_DEPTH,
  ESCALATION_SEARCH_DEPTH,
  SEARCH_ENDPOINT,
} from "../src/perplexity";
import { SecretsError } from "../src/secrets";
import type { PostSpec, TransportOutcome } from "../src/transport";

// ── argument grammar ─────────────────────────────────────────────────────────

function ask(argv: string[]): ParsedSearch {
  const parsed = parseSearchArgs(argv);
  if (!parsed.ok) throw new Error(`expected a parse, got ${parsed.kind}`);
  return parsed.args;
}

function faultMessage(argv: string[]): string {
  const parsed = parseSearchArgs(argv);
  if (parsed.ok || parsed.kind !== "fault") {
    throw new Error("expected an argument fault");
  }
  return parsed.message;
}

describe("parseSearchArgs", () => {
  test("bare invocation and --help ask for help", () => {
    expect(parseSearchArgs([])).toEqual({ ok: false, kind: "help" });
    expect(parseSearchArgs(["--help"])).toEqual({ ok: false, kind: "help" });
    expect(parseSearchArgs(["-h"])).toEqual({ ok: false, kind: "help" });
    expect(parseSearchArgs(["ask", "--help"])).toEqual({
      ok: false,
      kind: "help",
    });
  });

  test("--agent-help is a distinct runbook", () => {
    expect(parseSearchArgs(["--agent-help"])).toEqual({
      ok: false,
      kind: "agent-help",
    });
  });

  test("an unknown verb is an argument fault", () => {
    expect(faultMessage(["fetch", "x"])).toContain("unknown verb");
  });

  test("ask defaults to the shallowest depth agents may reach implicitly", () => {
    const args = ask(["ask", "why is the sky blue"]);
    expect(args).toMatchObject({ verb: "ask", depth: DEFAULT_SEARCH_DEPTH });
  });

  test("the escalation depth is selectable up front", () => {
    expect(ask(["ask", "q", "--depth", ESCALATION_SEARCH_DEPTH])).toMatchObject(
      {
        depth: ESCALATION_SEARCH_DEPTH,
      },
    );
  });

  test("ask takes a long multi-clause question verbatim", () => {
    const question =
      "how do A and B interact under C, what changed this year, and which is " +
      "cheaper at scale";
    expect(ask(["ask", question])).toMatchObject({ input: question });
  });

  test("an unknown depth is rejected before any request is shaped", () => {
    expect(faultMessage(["ask", "q", "--depth", "deepest"])).toContain(
      "--depth must be one of",
    );
  });

  test("--depth high demands --allow-expensive", () => {
    expect(faultMessage(["ask", "q", "--depth", "high"])).toContain(
      "--allow-expensive",
    );
    expect(
      ask(["ask", "q", "--depth", "high", "--allow-expensive"]),
    ).toMatchObject({ depth: "high" });
  });

  test("medium is selectable without the acknowledgement", () => {
    expect(ask(["ask", "q", "--depth", "medium"])).toMatchObject({
      depth: "medium",
    });
  });

  test("a bad recency window is rejected client-side", () => {
    expect(faultMessage(["find", "q", "--recency", "fortnight"])).toContain(
      "--recency must be one of",
    );
  });

  test("a mixed domain allow + deny list is rejected client-side", () => {
    expect(faultMessage(["find", "q", "--domains", "a.com,-b.com"])).toContain(
      "allowlist OR a denylist",
    );
  });

  test("repeated --domains flatten into one filter", () => {
    expect(
      ask(["find", "q", "--domains", "a.com", "--domains", "b.com,c.com"]),
    ).toMatchObject({ filters: { domains: ["a.com", "b.com", "c.com"] } });
  });

  test("find defaults to five hits and bounds --limit", () => {
    expect(ask(["find", "q"])).toMatchObject({ verb: "find", limit: 5 });
    expect(ask(["find", "q", "--limit", "10"])).toMatchObject({ limit: 10 });
    for (const bad of ["0", "-1", `${MAX_FIND_LIMIT + 1}`, "3.5", "many"]) {
      expect(faultMessage(["find", "q", "--limit", bad])).toContain("--limit");
    }
  });

  test("a missing or empty query is an argument fault", () => {
    expect(faultMessage(["ask"])).toContain("needs a question");
    expect(faultMessage(["find"])).toContain("needs a query");
    expect(faultMessage(["ask", "   "])).toContain("empty");
  });

  test("more than one positional is an argument fault", () => {
    expect(faultMessage(["find", "one", "two"])).toContain("exactly one");
  });

  test("--timeout speaks the shared duration grammar", () => {
    expect(ask(["find", "q", "--timeout", "30s"])).toMatchObject({
      timeoutMs: 30_000,
    });
    expect(faultMessage(["find", "q", "--timeout", "30"])).toContain(
      "needs a unit",
    );
  });

  test("--format yaml resolves; an unsupported mode is a fault", () => {
    expect(ask(["find", "q", "--format", "yaml"])).toMatchObject({
      format: "yaml",
    });
    expect(faultMessage(["find", "q", "--format", "toml"])).toContain(
      "not one of",
    );
  });

  test("no environment variable can raise the implicit depth", () => {
    const before = process.env.AGENTSEARCH_DEPTH;
    process.env.AGENTSEARCH_DEPTH = "high";
    try {
      expect(ask(["ask", "q"])).toMatchObject({ depth: DEFAULT_SEARCH_DEPTH });
    } finally {
      if (before === undefined) delete process.env.AGENTSEARCH_DEPTH;
      else process.env.AGENTSEARCH_DEPTH = before;
    }
  });
});

// ── help surfaces ────────────────────────────────────────────────────────────

describe("help text", () => {
  test("never quotes a static per-query price", () => {
    for (const text of [HELP, AGENT_HELP]) {
      expect(text).not.toMatch(/\$\s?\d/);
      expect(text).toContain("usage.cost_usd");
    }
  });

  test("the runbook teaches the ask-vs-find routing decision", () => {
    expect(AGENT_HELP).toContain("dominant path");
    expect(AGENT_HELP).toContain("SHORT keywords");
  });

  test("the runbook teaches BOTH depth paths, not just post-hoc escalation", () => {
    // Pre-routing a request that needs depth is cheaper than always starting
    // fast and retrying, so the runbook must teach the up-front judgement too.
    expect(AGENT_HELP).toContain(
      `Route to ${ESCALATION_SEARCH_DEPTH} UP FRONT`,
    );
    expect(AGENT_HELP).toContain(
      `Retry at ${ESCALATION_SEARCH_DEPTH} AFTER ${DEFAULT_SEARCH_DEPTH}`,
    );
    expect(AGENT_HELP).toContain("on a hunch");
  });

  test("the runbook refuses to imply a confidence score exists", () => {
    expect(AGENT_HELP).toContain("emits NO confidence");
  });

  test("the runbook names both credential sources", () => {
    expect(AGENT_HELP).toContain("secrets.yaml");
    expect(HELP).toContain("secrets.yaml");
  });

  test("the runbook never advertises URL fetching", () => {
    expect(AGENT_HELP).toContain("agentscrape");
    expect(AGENT_HELP).not.toMatch(/fetch a URL|--url\b/);
  });
});

describe("descriptor registration", () => {
  const descriptor = NATIVE_COMMANDS.find((c) => c.name === "agentsearch");

  test("is a public, daemon-free, mutating command with an agent runbook", () => {
    expect(descriptor).toMatchObject({
      visibility: "public",
      mutates: true,
      requires_daemon: false,
      requires_tty: false,
      agent_help: true,
      format_modes: ["json", "yaml"],
    });
  });

  test("declares exactly the ask and find verbs", () => {
    expect(descriptor?.verbs?.map((v) => v.name)).toEqual(["ask", "find"]);
  });

  test("the derived parse surfaces match the flags the leaf accepts", () => {
    expect(parseOptions("agentsearch", "ask")).toEqual({
      help: { type: "boolean", short: "h" },
      format: { type: "string" },
      json: { type: "boolean" },
      depth: { type: "string" },
      "allow-expensive": { type: "boolean", default: false },
      recency: { type: "string" },
      domains: { type: "string", multiple: true },
      timeout: { type: "string" },
    });
    expect(parseOptions("agentsearch", "find")).toEqual({
      help: { type: "boolean", short: "h" },
      format: { type: "string" },
      json: { type: "boolean" },
      limit: { type: "string" },
      recency: { type: "string" },
      domains: { type: "string", multiple: true },
      timeout: { type: "string" },
    });
  });
});

// ── execution ────────────────────────────────────────────────────────────────

interface Run {
  stdout: string;
  stderr: string;
  code: number;
  posts: PostSpec[];
  reserved: number;
  settled: Array<Record<string, unknown>>;
}

class ExitCapture extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

interface RunOptions {
  outcome?: TransportOutcome;
  env?: Record<string, string | undefined>;
  reserveOk?: boolean;
  reserveThrows?: boolean;
  settleThrows?: boolean;
  postThrows?: boolean;
  warnFraction?: number;
  resolveApiKey?: RunSearchDeps["resolveApiKey"];
}

async function run(argv: string[], options: RunOptions = {}): Promise<Run> {
  const args = ask(argv);
  const posts: PostSpec[] = [];
  const settled: Array<Record<string, unknown>> = [];
  let reserved = 0;
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;

  const window = (spentUsd: number, warnFraction: number | null) => ({
    name: "rolling" as const,
    spentUsd,
    capUsd: 5,
    windowHours: 24,
    warnFraction,
  });
  const reserve: typeof reserveSpend = () => {
    reserved += 1;
    if (options.reserveThrows === true) throw new Error("lock is unusable");
    return options.reserveOk === false
      ? {
          ok: false,
          holdUsd: 0.02,
          blocked: window(5, null),
          windows: [window(5, null)],
        }
      : {
          ok: true,
          id: "r1",
          holdUsd: 0.02,
          windows: [window(0, options.warnFraction ?? null)],
        };
  };
  const settle: typeof settleSpend = (record) => {
    if (options.settleThrows === true) throw new Error("ledger write failed");
    settled.push(record as unknown as Record<string, unknown>);
  };

  const deps: RunSearchDeps = {
    env: options.env ?? { PERPLEXITY_API_KEY: "test-key" },
    ...(options.resolveApiKey === undefined
      ? {}
      : { resolveApiKey: options.resolveApiKey }),
    post: async (spec) => {
      posts.push(spec);
      if (options.postThrows === true) throw new Error("transport exploded");
      return (
        options.outcome ?? {
          kind: "response",
          status: 200,
          body: "{}",
          latencyMs: 12,
          attempts: 1,
        }
      );
    },
    reserve,
    settle,
    writeStdout: (s) => out.push(s),
    writeStderr: (s) => err.push(s),
    exit: (c) => {
      throw new ExitCapture(c);
    },
  };

  try {
    await runSearchCommand(args, deps);
  } catch (error) {
    if (error instanceof ExitCapture) code = error.code;
    else throw error;
  }
  return {
    stdout: out.join(""),
    stderr: err.join(""),
    code,
    posts,
    reserved,
    settled,
  };
}

function envelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

const COMPLETED_ASK = JSON.stringify({
  id: "resp_1",
  status: "completed",
  model: "some/dynamic-model",
  output: [
    {
      type: "search_results",
      results: [{ id: 1, url: "https://example.com/a", title: "A" }],
    },
    { type: "message", content: [{ text: "Answer [1]." }] },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cost: {
      total_cost: 0.004,
      tool_calls_cost_details: { search_web: 0.0025 },
    },
  },
});

describe("runSearchCommand", () => {
  test("a completed ask emits the compact payload on the shared envelope", async () => {
    const result = await run(["ask", "q"], {
      outcome: {
        kind: "response",
        status: 200,
        body: COMPLETED_ASK,
        latencyMs: 900,
        attempts: 1,
      },
    });
    expect(result.code).toBe(0);
    const env = envelope(result.stdout);
    expect(env.schema_version).toBe(SEARCH_SCHEMA_VERSION);
    expect(env.ok).toBe(true);
    const data = env.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["answer", "sources", "usage"]);
    expect(data.answer).toBe("Answer [1].");
    const usage = data.usage as Record<string, unknown>;
    // Dynamic presets: assert the accounting fields parse, never their values.
    expect(typeof usage.cost_usd).toBe("number");
    expect(typeof usage.model).toBe("string");
    expect(usage.depth).toBe(DEFAULT_SEARCH_DEPTH);
    expect(usage.response_id).toBe("resp_1");
  });

  test("the secrets file supplies the key when the environment does not", async () => {
    const result = await run(["find", "q"], {
      env: {},
      resolveApiKey: () => "from-secrets-file",
      outcome: {
        kind: "response",
        status: 200,
        body: JSON.stringify({ id: "s", results: [] }),
        latencyMs: 5,
        attempts: 1,
      },
    });
    expect(result.code).toBe(0);
    expect(result.posts[0]?.apiKey).toBe("from-secrets-file");
  });

  test("a corrupt secrets file is its own error, and never reserves", async () => {
    const result = await run(["ask", "q"], {
      env: {},
      resolveApiKey: () => {
        throw new SecretsError(
          "the agentsearch secrets file is not valid YAML",
        );
      },
    });
    expect(result.code).toBe(1);
    expect(result.reserved).toBe(0);
    expect(result.posts).toHaveLength(0);
    expect(envelope(result.stdout).error).toMatchObject({
      code: "secrets_unreadable",
    });
  });

  test("the credential never reaches an emitted error", async () => {
    const secret = "pplx-fixture-secret-value-not-real";
    const result = await run(["find", "q"], {
      env: { PERPLEXITY_API_KEY: secret },
      outcome: {
        kind: "response",
        status: 400,
        // A provider that echoed the key back would otherwise leak it onward.
        body: JSON.stringify({ error: { message: `bad key ${secret}` } }),
        latencyMs: 5,
        attempts: 1,
      },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain("[redacted]");
  });

  test("a crossed spend threshold warns on stderr without refusing", async () => {
    const result = await run(["find", "q"], {
      warnFraction: 0.8,
      outcome: {
        kind: "response",
        status: 200,
        body: JSON.stringify({ id: "s", results: [] }),
        latencyMs: 5,
        attempts: 1,
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("80%");
    // Warning is telemetry: the request still went out.
    expect(result.posts).toHaveLength(1);
  });

  test("the ledger records the citation audit alongside the source count", async () => {
    const result = await run(["ask", "q"], {
      outcome: {
        kind: "response",
        status: 200,
        body: COMPLETED_ASK,
        latencyMs: 900,
        attempts: 1,
      },
    });
    expect(result.settled[0]).toMatchObject({
      source_count: 1,
      citation_ref_count: 1,
      unresolved_ref_count: 0,
    });
  });

  test("ask posts to the agent endpoint with no tools when unfiltered", async () => {
    const result = await run(["ask", "q"], {
      outcome: {
        kind: "response",
        status: 200,
        body: COMPLETED_ASK,
        latencyMs: 1,
        attempts: 1,
      },
    });
    expect(result.posts[0]?.url).toBe(AGENT_ENDPOINT);
    expect(Object.keys(result.posts[0]?.body as object).sort()).toEqual([
      "input",
      "preset",
    ]);
  });

  test("find posts to the search endpoint and emits hits", async () => {
    const result = await run(["find", "bun sqlite wal"], {
      outcome: {
        kind: "response",
        status: 200,
        body: JSON.stringify({
          id: "srch_1",
          results: [
            {
              url: "https://example.com/x",
              title: "X",
              snippet: "s",
              summary: "dupe",
            },
          ],
        }),
        latencyMs: 30,
        attempts: 1,
      },
    });
    expect(result.code).toBe(0);
    expect(result.posts[0]?.url).toBe(SEARCH_ENDPOINT);
    const data = envelope(result.stdout).data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["hits", "total", "usage"]);
    expect(data.total).toBe(1);
    expect(JSON.stringify(data)).not.toContain("dupe");
  });

  test("a settle records the call's outcome without the query text", async () => {
    const result = await run(["ask", "a secret question"], {
      outcome: {
        kind: "response",
        status: 200,
        body: COMPLETED_ASK,
        latencyMs: 900,
        attempts: 1,
      },
    });
    expect(result.settled).toHaveLength(1);
    const record = result.settled[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      id: "r1",
      verb: "ask",
      depth: DEFAULT_SEARCH_DEPTH,
      status: "completed",
      latency_ms: 900,
      attempts: 1,
      released: false,
    });
    expect(JSON.stringify(record)).not.toContain("a secret question");
  });

  test("a missing API key never reserves and never posts", async () => {
    const result = await run(["ask", "q"], {
      env: {},
      resolveApiKey: () => null,
    });
    expect(result.code).toBe(1);
    expect(result.reserved).toBe(0);
    expect(result.posts).toHaveLength(0);
    const error = envelope(result.stdout).error as Record<string, unknown>;
    expect(error.code).toBe("missing_api_key");
  });

  test("an exhausted budget refuses with a structured error and no request", async () => {
    const result = await run(["ask", "q"], { reserveOk: false });
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(0);
    const error = envelope(result.stdout).error as Record<string, unknown>;
    expect(error.code).toBe("budget_exceeded");
    expect(error.details).toMatchObject({
      blocked_window: "rolling",
      cap_usd: 5,
      window_hours: 24,
    });
  });

  test("an unusable ledger fails CLOSED — the paid request is skipped", async () => {
    const result = await run(["ask", "q"], { reserveThrows: true });
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(0);
    expect(envelope(result.stdout).error).toMatchObject({
      code: "ledger_unavailable",
    });
  });

  test("a non-completed status is an error, never a partial success", async () => {
    const result = await run(["ask", "q"], {
      outcome: {
        kind: "response",
        status: 200,
        body: JSON.stringify({
          id: "resp_2",
          status: "incomplete",
          model: "m",
          usage: { cost: { total_cost: 0.002 } },
        }),
        latencyMs: 400,
        attempts: 1,
      },
    });
    expect(result.code).toBe(1);
    const env = envelope(result.stdout);
    expect(env.data).toBeNull();
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe("answer_incomplete");
    // The spend stays accountable: id and known cost survive into details.
    expect(error.details).toMatchObject({
      response_id: "resp_2",
      cost_usd: 0.002,
      retry_safe: false,
    });
    // And the hold is settled at the known cost, not released.
    expect(result.settled[0]).toMatchObject({
      status: "incomplete",
      cost_usd: 0.002,
      released: false,
    });
  });

  test("a connect failure releases the hold and reports a safe retry", async () => {
    const result = await run(["ask", "q"], {
      outcome: {
        kind: "connect_failed",
        message: "connect ECONNREFUSED",
        latencyMs: 5,
        attempts: 2,
      },
    });
    expect(result.code).toBe(1);
    expect(result.settled[0]).toMatchObject({
      status: "connect_failed",
      released: true,
    });
    const error = envelope(result.stdout).error as Record<string, unknown>;
    expect(error.code).toBe("search_failed");
    expect(error.details).toMatchObject({ retry_safe: true, attempts: 2 });
    expect(error.recovery).toContain("never reached the provider");
  });

  test("an ambiguous failure KEEPS the hold and warns against a retry", async () => {
    const result = await run(["ask", "q"], {
      outcome: {
        kind: "ambiguous",
        message: "The operation was aborted",
        latencyMs: 180_000,
        attempts: 1,
      },
    });
    expect(result.code).toBe(1);
    expect(result.settled[0]).toMatchObject({ released: false });
    const error = envelope(result.stdout).error as Record<string, unknown>;
    expect(error.details).toMatchObject({ retry_safe: false });
    expect(error.recovery).toContain("do NOT blind-retry");
  });

  test("a 4xx releases the hold; a 5xx keeps it", async () => {
    const rejected = await run(["find", "q"], {
      outcome: {
        kind: "response",
        status: 400,
        body: '{"error":{"message":"bad request"}}',
        latencyMs: 20,
        attempts: 1,
      },
    });
    expect(rejected.settled[0]).toMatchObject({
      status: "http_400",
      released: true,
    });
    const error = envelope(rejected.stdout).error as Record<string, unknown>;
    expect(error.details).toMatchObject({ provider_message: "bad request" });
    // A rejection DID reach the provider — the recovery must not claim otherwise.
    expect(error.recovery).toContain("rejected the request outright");
    expect(error.recovery).not.toContain("never reached");

    const serverSide = await run(["find", "q"], {
      outcome: {
        kind: "response",
        status: 503,
        body: "",
        latencyMs: 20,
        attempts: 1,
      },
    });
    expect(serverSide.settled[0]).toMatchObject({
      status: "http_503",
      released: false,
    });
  });

  test("an unexpected transport throw settles as ambiguous, never crashes", async () => {
    const result = await run(["ask", "q"], { postThrows: true });
    expect(result.code).toBe(1);
    // The hold is retained: nothing here proves the request went unserved.
    expect(result.settled[0]).toMatchObject({
      status: "ambiguous",
      released: false,
    });
    expect(envelope(result.stdout).error).toMatchObject({
      code: "search_failed",
    });
  });

  test("a failed settle still delivers the paid-for answer, and says so", async () => {
    const result = await run(["ask", "q"], {
      settleThrows: true,
      outcome: {
        kind: "response",
        status: 200,
        body: COMPLETED_ASK,
        latencyMs: 900,
        attempts: 1,
      },
    });
    expect(result.code).toBe(0);
    expect(envelope(result.stdout).ok).toBe(true);
    // The hold is left standing rather than silently booked as free.
    expect(result.stderr).toContain("budget hold stands");
  });

  test("--format yaml renders the same envelope as YAML", async () => {
    const result = await run(["find", "q", "--format", "yaml"], {
      outcome: {
        kind: "response",
        status: 200,
        body: JSON.stringify({ id: "s", results: [] }),
        latencyMs: 5,
        attempts: 1,
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("schema_version:");
    expect(result.stdout).toContain("ok: true");
  });
});
