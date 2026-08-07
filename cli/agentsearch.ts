#!/usr/bin/env bun
/**
 * `agentsearch <ask|find>` — grounded web research from the CLI.
 *
 * `ask` buys a synthesized, cited answer: the depth preset decomposes one dense
 * question into parallel retrievals and writes the answer, so a caller hands it
 * the WHOLE question rather than pre-splitting it. `find` buys ranked hits and
 * nothing else — no decomposition model sits behind it, so its queries are short
 * keywords and unrelated concepts belong in separate calls.
 *
 * Both verbs spend real money on every invocation, which shapes the control
 * flow: the depth default is a constant no environment can raise, `--depth high`
 * additionally demands `--allow-expensive`, a rolling budget hold is taken
 * BEFORE the request and settled to the actual cost after, and an ambiguous POST
 * failure is never retried — these endpoints carry no idempotency key, so a
 * blind retry can bill twice.
 *
 * Output rides the shared `{schema_version, ok, error, data}` envelope on stdout
 * (`--format yaml` renders the same value as YAML). `data` is deliberately
 * compact — an answer, its deduped sources, and usage; never snippets, reasoning
 * traces, or the raw provider payload.
 *
 * Page fetching is NOT here. This verb retrieves and reasons over search
 * results; pulling a specific URL's content belongs to agentscrape.
 */

import { parseArgs } from "node:util";
import { parseDuration } from "../src/duration";
import {
  DEPTH_HOLD_USD,
  FIND_HOLD_USD,
  type LedgerDeps,
  reserveSpend,
  type SearchVerb,
  type SettleInput,
  settleSpend,
  type WindowState,
} from "../src/ledger";
import {
  AGENT_ENDPOINT,
  type AskPayload,
  auditCitations,
  buildAgentRequestBody,
  buildSearchRequestBody,
  type CostStatus,
  DEFAULT_FIND_LIMIT,
  DEFAULT_SEARCH_DEPTH,
  ESCALATION_SEARCH_DEPTH,
  type FindPayload,
  GUARDED_DEPTHS,
  isRecency,
  isSearchDepth,
  parseAgentResponse,
  parseDomainFilter,
  parseSearchResponse,
  RECENCY_WINDOWS,
  SEARCH_DEPTHS,
  SEARCH_ENDPOINT,
  type SearchDepth,
  type SearchFilters,
} from "../src/perplexity";
import { resolveSecret, SecretsError } from "../src/secrets";
import {
  type PostSpec,
  postJson,
  type TransportDeps,
  type TransportOutcome,
} from "../src/transport";
import type { FormatMode } from "./descriptor";
import { parseOptions } from "./descriptor";
import { errorEnvelope, type ProblemError, successEnvelope } from "./envelope";
import { emitEnvelopeFormatted, resolveFormat } from "./format";

export const SEARCH_SCHEMA_VERSION = 1;

/** Request deadlines. `ask` runs a multi-step research loop and needs room; a
 *  `find` is one retrieval round trip. */
export const DEFAULT_ASK_TIMEOUT_MS = 180_000;
export const DEFAULT_FIND_TIMEOUT_MS = 60_000;

/** This verb's own bound on `find --limit`. */
export const MAX_FIND_LIMIT = 20;

/** Cap on the provider-supplied failure text carried into `error.details`. */
const PROVIDER_MESSAGE_CAP = 400;

export const HELP = `agentsearch — grounded web answers (ask) and ranked web hits (find)

Usage:
  agentsearch ask  "<question>" [--depth fast|low|medium|high] [flags]
  agentsearch find "<query>" [--limit <n>] [flags]
  agentsearch --agent-help
  agentsearch --help

Verbs:
  ask   A synthesized, cited answer to a dense question. Hand it the whole
        question — the depth preset decomposes it into parallel retrievals.
  find  Ranked hits (url, title, snippet) for the caller to read and judge.
        No decomposition: keep the query to short keywords, and split unrelated
        concepts into separate calls.

Flags (ask):
  --depth <fast|low|medium|high>  Research depth (default ${DEFAULT_SEARCH_DEPTH}); ${ESCALATION_SEARCH_DEPTH} is the
                                  escalation, fast an opt-DOWN for one fact
  --allow-expensive               Required alongside --depth high
  --recency <${RECENCY_WINDOWS.join("|")}>
  --domains <a.com,b.com>         Repeatable. An allowlist, or a denylist whose
                                  every entry is prefixed '-'. Never both.
  --timeout <duration>            Request deadline, e.g. 90s, 3m
  --format <json|yaml>            Output format (default json)
  --json                          Alias of --format json
  --help, -h                      Show this help

Flags (find):
  --limit <n>                     Hits to return, 1-${MAX_FIND_LIMIT} (default ${DEFAULT_FIND_LIMIT})
  --recency, --domains, --timeout, --format, --json, --help  as above

Auth:
  PERPLEXITY_API_KEY from the environment, else the line
  'PERPLEXITY_API_KEY: <key>' in ~/.config/agentsearch/secrets.yaml. The file leg is
  what makes this work under hooks and daemons, which inherit no shell profile.

Cost:
  Both verbs are usage-based — read data.usage.cost_usd on the response for what
  a call actually cost. Every call appends a record (never the query text) to the
  local ledger under the agentsearch state directory, and two rolling budget windows
  refuse the call once either cap is reached. Tune with AGENTSEARCH_BUDGET_USD,
  AGENTSEARCH_BUDGET_WINDOW_HOURS, and AGENTSEARCH_BUDGET_MONTHLY_USD; the
  defaults are conservative.

Exit codes:
  0  the answer / hits were emitted
  1  a transport, provider, budget, or ledger failure (ok:false envelope on stdout)
  2  usage / argument fault

Run agentsearch --agent-help for the agent runbook.
`;

export const AGENT_HELP = `agentsearch — operator runbook (agent-facing)

  agentsearch ask  "<dense multi-clause question>"   # you want the ANSWER
  agentsearch find "<short keywords>"                # you want the LINKS

Routing:
  ask   The dominant path. Use it whenever you want a synthesized, cited answer
        rather than a reading list. Give it the WHOLE question — long,
        multi-clause, several constraints at once. The preset decomposes it into
        parallel keyword searches itself, so pre-shortening a question for 'ask'
        makes the answer worse, not cheaper.
  find  Use it for source discovery: links, titles, raw evidence you will analyze
        yourself. 'find' has no decomposition model, so give it SHORT keywords
        and split unrelated concepts into separate calls instead of concatenating
        them into one long query.

Depth (ask --depth, default ${DEFAULT_SEARCH_DEPTH}):
  Use ${DEFAULT_SEARCH_DEPTH} by default. Route to ${ESCALATION_SEARCH_DEPTH} up front when the request
  requires depth. After ${DEFAULT_SEARCH_DEPTH}, retry at ${ESCALATION_SEARCH_DEPTH} only when a specific
  requested facet is missing; never because the answer merely seemed thin.

  low     The default. It fully answers most questions, including dense
          multi-clause ones.
  medium  The escalation. Highest facet coverage and the fewest suspect claims,
          at higher latency.
  fast    An opt-DOWN for a SINGLE fact, a definition, or a quick summary —
          nothing more. It is NOT a general cheaper mode: on a multi-part
          question it silently drops facets, and the re-run that follows makes
          it the most expensive route per question actually answered. Reaching
          for it to save money is a false economy.
  high    Exhaustive research only. Explicit, rare, slow — additionally
          requires --allow-expensive.
  Nothing in the environment or in config can raise the implicit depth above
  ${DEFAULT_SEARCH_DEPTH}; a deeper run is always an explicit flag.

  Route to ${ESCALATION_SEARCH_DEPTH} UP FRONT when the request itself carries any of:
    - several independent subquestions that must all be answered
    - comparison or reconciliation across sources
    - primary-source verification or an evidence audit
    - root-cause investigation needing successive searches
    - broad landscape or current-state research
    - the words comprehensive, exhaustive, investigate, or deep

  Retry at ${ESCALATION_SEARCH_DEPTH} AFTER ${DEFAULT_SEARCH_DEPTH} only on hard structural evidence, never
  on a hunch about tone or length:
    - an empty or missing answer
    - zero usable sources while the answer makes web-derived claims
    - a specifically named or enumerated requested facet visibly absent
  A concise, single-source answer can be entirely correct. Judge the request and
  the evidence, not the prose.

Filters (both verbs):
  --recency ${RECENCY_WINDOWS.join("|")}
  --domains a.com,b.com     Allowlist. A denylist prefixes EVERY entry with '-'
                            (e.g. -reddit.com). Never mix the two; max 20.

Reading the result — stdout is the {schema_version, ok, error, data} envelope:
  ask   data = {answer, sources[], usage}. sources is the EVIDENCE SET the
        answer was written from — deduped by URL, and including pages that were
        retrieved but never cited. It is not a list of inline references: these
        presets do not reliably write [web:N] markers into the prose. When a
        marker IS present it matches a sources[].ref verbatim, never renumbered,
        so an unresolvable ref is mechanically detectable.
  find  data = {hits[], total, usage}.

Judge an answer on its evidence, not on a score: this verb emits depth, sources,
source refs, tool counts, and status, and deliberately emits NO confidence
number. A synthesized score would carry authority it has not earned.

Cost is usage-based, never a flat per-query figure: read data.usage.cost_usd and
data.usage.cost_status. A cost_status of "unavailable" means the provider
returned no cost for that call — an accounting fault to report, never a zero.
Two local budget windows, a rolling one and a 30-day one, refuse a call with
error.code budget_exceeded once either cap is spent; both caps are env-tunable
(AGENTSEARCH_BUDGET_USD, AGENTSEARCH_BUDGET_WINDOW_HOURS,
AGENTSEARCH_BUDGET_MONTHLY_USD) and default conservatively.

Auth resolves PERPLEXITY_API_KEY from the environment first, then from
~/.config/agentsearch/secrets.yaml — so this works under hooks and daemons that
inherit no shell profile.

Failure: error.code is one of missing_api_key, secrets_unreadable,
budget_exceeded, ledger_unavailable, search_failed, answer_incomplete,
malformed_response. error.details.retry_safe says whether re-running is safe.
Only clean connect failures and 429s are retried automatically — an ambiguous
POST is never retried, because these endpoints carry no idempotency key and a
retry can bill twice.

Not here: fetching a specific URL's content. That is agentscrape's job.
`;

// ── argument parsing ─────────────────────────────────────────────────────────

export interface ParsedAsk {
  readonly verb: "ask";
  readonly input: string;
  readonly depth: SearchDepth;
  readonly filters: SearchFilters;
  readonly timeoutMs: number;
  readonly format: FormatMode;
}

export interface ParsedFind {
  readonly verb: "find";
  readonly query: string;
  readonly limit: number;
  readonly filters: SearchFilters;
  readonly timeoutMs: number;
  readonly format: FormatMode;
}

export type ParsedSearch = ParsedAsk | ParsedFind;

export type SearchParseResult =
  | { readonly ok: true; readonly args: ParsedSearch }
  | { readonly ok: false; readonly kind: "help" }
  | { readonly ok: false; readonly kind: "agent-help" }
  | { readonly ok: false; readonly kind: "fault"; readonly message: string };

function fault(message: string): SearchParseResult {
  return { ok: false, kind: "fault", message };
}

/** Shared `--recency` / `--domains` resolution. */
function parseFilters(
  values: Record<string, unknown>,
): { ok: true; filters: SearchFilters } | { ok: false; message: string } {
  let recency: SearchFilters["recency"] = null;
  if (typeof values.recency === "string") {
    if (!isRecency(values.recency)) {
      return {
        ok: false,
        message: `--recency must be one of ${RECENCY_WINDOWS.join("|")}, got '${values.recency}'`,
      };
    }
    recency = values.recency;
  }
  const raw = Array.isArray(values.domains) ? (values.domains as string[]) : [];
  const domains = parseDomainFilter(raw);
  if (!domains.ok) return { ok: false, message: domains.message };
  return { ok: true, filters: { recency, domains: domains.entries } };
}

function parseTimeout(
  values: Record<string, unknown>,
  fallbackMs: number,
): { ok: true; ms: number } | { ok: false; message: string } {
  if (typeof values.timeout !== "string") return { ok: true, ms: fallbackMs };
  const parsed = parseDuration(values.timeout);
  return parsed.ok
    ? { ok: true, ms: parsed.ms }
    : { ok: false, message: `--timeout ${parsed.message}` };
}

/**
 * Parse the `agentsearch` argv. Every fault that the provider would charge for
 * — an unknown depth, a mixed domain allow/deny list, an over-long domain list,
 * a guarded depth without its acknowledgement — is caught here, before a request
 * is shaped.
 */
export function parseSearchArgs(argv: readonly string[]): SearchParseResult {
  const verb = argv[0];
  if (verb === undefined || verb === "--help" || verb === "-h") {
    return { ok: false, kind: "help" };
  }
  if (verb === "--agent-help") return { ok: false, kind: "agent-help" };
  if (verb !== "ask" && verb !== "find") {
    return fault(`unknown verb '${verb}' (expected ask | find)`);
  }

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv.slice(1)],
      options: parseOptions("agentsearch", verb),
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (err) {
    return fault(err instanceof Error ? err.message : String(err));
  }
  if (values.help === true) return { ok: false, kind: "help" };

  const fmt = resolveFormat("agentsearch", values);
  if (!fmt.ok) return fault(fmt.message);

  if (positionals.length === 0) {
    return fault(
      verb === "ask"
        ? "ask needs a question (quote it as one argument)"
        : "find needs a query (quote it as one argument)",
    );
  }
  if (positionals.length > 1) {
    return fault(
      `expected exactly one quoted ${verb === "ask" ? "question" : "query"} (got ${positionals.length})`,
    );
  }
  const text = (positionals[0] as string).trim();
  if (text.length === 0) {
    return fault(
      `the ${verb === "ask" ? "question" : "query"} is empty after trimming`,
    );
  }

  const filters = parseFilters(values);
  if (!filters.ok) return fault(filters.message);

  if (verb === "find") {
    const timeout = parseTimeout(values, DEFAULT_FIND_TIMEOUT_MS);
    if (!timeout.ok) return fault(timeout.message);
    let limit = DEFAULT_FIND_LIMIT;
    if (typeof values.limit === "string") {
      const parsed = Number(values.limit);
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_FIND_LIMIT
      ) {
        return fault(
          `--limit must be an integer between 1 and ${MAX_FIND_LIMIT}, got '${values.limit}'`,
        );
      }
      limit = parsed;
    }
    return {
      ok: true,
      args: {
        verb: "find",
        query: text,
        limit,
        filters: filters.filters,
        timeoutMs: timeout.ms,
        format: fmt.format,
      },
    };
  }

  const timeout = parseTimeout(values, DEFAULT_ASK_TIMEOUT_MS);
  if (!timeout.ok) return fault(timeout.message);
  // The default is a constant read only here: no env var and no config key
  // participates, so nothing can raise the implicit depth.
  let depth: SearchDepth = DEFAULT_SEARCH_DEPTH;
  if (typeof values.depth === "string") {
    if (!isSearchDepth(values.depth)) {
      return fault(
        `--depth must be one of ${SEARCH_DEPTHS.join("|")}, got '${values.depth}'`,
      );
    }
    depth = values.depth;
  }
  if (GUARDED_DEPTHS.has(depth) && values["allow-expensive"] !== true) {
    return fault(
      `--depth ${depth} also requires --allow-expensive (it is materially more expensive than ${DEFAULT_SEARCH_DEPTH})`,
    );
  }
  return {
    ok: true,
    args: {
      verb: "ask",
      input: text,
      depth,
      filters: filters.filters,
      timeoutMs: timeout.ms,
      format: fmt.format,
    },
  };
}

// ── execution ────────────────────────────────────────────────────────────────

export interface RunSearchDeps {
  readonly env?: Record<string, string | undefined>;
  readonly post?: (
    spec: PostSpec,
    deps?: TransportDeps,
  ) => Promise<TransportOutcome>;
  readonly reserve?: typeof reserveSpend;
  readonly settle?: typeof settleSpend;
  readonly resolveApiKey?: typeof resolveSecret;
  readonly ledger?: LedgerDeps;
  readonly writeStdout: (s: string) => void;
  readonly writeStderr: (s: string) => void;
  readonly exit: (code: number) => never;
}

/** The credential this verb resolves, in both the environment and the agentsearch
 *  secrets file. */
export const API_KEY_NAME = "PERPLEXITY_API_KEY";

const RECOVERY_MISSING_KEY =
  "Export PERPLEXITY_API_KEY in the environment, or add the line " +
  "'PERPLEXITY_API_KEY: <key>' to ~/.config/agentsearch/secrets.yaml, then re-run. " +
  "No request was sent and nothing was spent.";

const RECOVERY_SECRETS =
  "Repair ~/.config/agentsearch/secrets.yaml — it must be a flat YAML map such as " +
  "'PERPLEXITY_API_KEY: <key>'. No request was sent and nothing was spent.";

const RECOVERY_BUDGET =
  "The rolling search budget for this window is spent. Wait for the window to " +
  "roll forward, or raise AGENTSEARCH_BUDGET_USD. No request was sent and " +
  "nothing was spent.";

const RECOVERY_LEDGER =
  "The local cost ledger could not be read or locked, so the paid request was " +
  "not sent. Confirm the agentsearch state directory is writable, then retry.";

const RECOVERY_UNREACHED =
  "The request never reached the provider, so nothing was billed. Retry is safe.";

const RECOVERY_REJECTED =
  "The provider rejected the request outright rather than serving it, so " +
  "nothing was billed. Read error.details.provider_message, fix the request or " +
  "the credentials, then retry.";

const RECOVERY_AMBIGUOUS =
  "The provider may have served and billed this request before the failure. " +
  "These endpoints carry no idempotency key, so do NOT blind-retry — read the " +
  "cost ledger under the agentsearch state directory first.";

function extractProviderMessage(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.trim().length === 0
      ? null
      : body.trim().slice(0, PROVIDER_MESSAGE_CAP);
  }
  const seek = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error"]) {
      const found = seek(record[key]);
      if (found !== null) return found;
    }
    return null;
  };
  const message = seek(parsed);
  return message === null ? null : message.slice(0, PROVIDER_MESSAGE_CAP);
}

/** How a settled call is classified for the ledger and the error envelope. */
interface Outcome {
  readonly status: string;
  /** True only when the request provably never reached the provider. */
  readonly released: boolean;
  /** True when re-running cannot double-bill. */
  readonly retrySafe: boolean;
}

function classifyTransport(outcome: TransportOutcome): Outcome {
  if (outcome.kind === "connect_failed") {
    return { status: "connect_failed", released: true, retrySafe: true };
  }
  if (outcome.kind === "ambiguous") {
    return { status: "ambiguous", released: false, retrySafe: false };
  }
  const status = `http_${outcome.status}`;
  // A 4xx is a terminal rejection the provider does not bill, so its hold is
  // released. A 5xx arrives after the request was accepted and may have been
  // billed, so the hold stands and a retry is not offered as safe.
  if (outcome.status >= 400 && outcome.status < 500) {
    return { status, released: true, retrySafe: true };
  }
  return { status, released: false, retrySafe: false };
}

function transportProblem(
  outcome: TransportOutcome,
  classified: Outcome,
): ProblemError {
  const details: Record<string, unknown> = {
    attempts: outcome.attempts,
    latency_ms: outcome.latencyMs,
    retry_safe: classified.retrySafe,
  };
  let message: string;
  if (outcome.kind === "response") {
    details.http_status = outcome.status;
    const provider = extractProviderMessage(outcome.body);
    if (provider !== null) details.provider_message = provider;
    message = `the provider answered HTTP ${outcome.status}`;
  } else {
    message =
      outcome.kind === "connect_failed"
        ? `the request never reached the provider: ${outcome.message}`
        : `the request failed after it was sent: ${outcome.message}`;
  }
  return {
    code: "search_failed",
    message,
    recovery: !classified.retrySafe
      ? RECOVERY_AMBIGUOUS
      : outcome.kind === "connect_failed"
        ? RECOVERY_UNREACHED
        : RECOVERY_REJECTED,
    details,
  };
}

interface Settlement {
  readonly status: string;
  readonly released: boolean;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCalls: Record<string, number>;
  readonly sourceCount: number;
  readonly citationRefCount: number;
  readonly unresolvedRefCount: number;
  readonly costUsd: number | null;
  readonly costStatus: CostStatus;
  readonly responseId: string | null;
}

function settlementFor(
  verb: SearchVerb,
  depth: SearchDepth | null,
  reservationId: string,
  outcome: TransportOutcome,
  settlement: Settlement,
): SettleInput {
  return {
    id: reservationId,
    verb,
    depth,
    model: settlement.model,
    status: settlement.status,
    attempts: outcome.attempts,
    latency_ms: outcome.latencyMs,
    input_tokens: settlement.inputTokens,
    output_tokens: settlement.outputTokens,
    tool_calls: settlement.toolCalls,
    source_count: settlement.sourceCount,
    citation_ref_count: settlement.citationRefCount,
    unresolved_ref_count: settlement.unresolvedRefCount,
    cost_usd: settlement.costUsd,
    cost_status: settlement.costStatus,
    response_id: settlement.responseId,
    released: settlement.released,
  };
}

const EMPTY_SETTLEMENT: Omit<Settlement, "status" | "released"> = {
  model: null,
  inputTokens: null,
  outputTokens: null,
  toolCalls: {},
  sourceCount: 0,
  citationRefCount: 0,
  unresolvedRefCount: 0,
  costUsd: null,
  costStatus: "unavailable",
  responseId: null,
};

/** Render the crossed spend warnings for one reservation. Telemetry only — it
 *  never refuses a call and never changes a cap. */
function spendWarnings(windows: readonly WindowState[]): string[] {
  const lines: string[] = [];
  for (const window of windows) {
    if (window.warnFraction === null) continue;
    lines.push(
      `agentsearch: ${Math.round(window.warnFraction * 100)}% of the ` +
        `${window.name} search budget window is committed ` +
        `(${window.spentUsd.toFixed(4)} of ${window.capUsd.toFixed(2)} USD ` +
        `over ${window.windowHours}h)\n`,
    );
  }
  return lines;
}

/**
 * Run one search. The order is load-bearing: validate, resolve auth, take a
 * budget hold, send exactly one request (retried only on a proven-unserved
 * failure), then settle the hold to what the call actually cost. A ledger fault
 * fails CLOSED — the paid request is skipped rather than sent unmetered.
 */
export async function runSearchCommand(
  args: ParsedSearch,
  deps: RunSearchDeps,
): Promise<void> {
  const env = deps.env ?? process.env;
  const post = deps.post ?? postJson;
  const reserve = deps.reserve ?? reserveSpend;
  const settle = deps.settle ?? settleSpend;
  const resolveKey = deps.resolveApiKey ?? resolveSecret;
  const ledgerDeps = deps.ledger ?? {};

  // Defense in depth: no error path is expected to carry the credential, but a
  // single scrub at the one emit site means no future one can either.
  let apiKey: string | null = null;
  const emitError = (error: ProblemError): void => {
    const safe =
      apiKey === null || apiKey.length < 8
        ? error
        : (JSON.parse(
            JSON.stringify(error).split(apiKey).join("[redacted]"),
          ) as ProblemError);
    emitEnvelopeFormatted(
      errorEnvelope(SEARCH_SCHEMA_VERSION, safe),
      deps,
      args.format,
    );
  };

  // Credential resolution is LAZY — inside the run path, never at module load —
  // so no help or completion path reads a secrets file.
  try {
    apiKey = resolveKey(API_KEY_NAME, { env });
  } catch (err) {
    emitError({
      code: "secrets_unreadable",
      message:
        err instanceof SecretsError
          ? err.message
          : "the agentsearch secrets file could not be read",
      recovery: RECOVERY_SECRETS,
    });
    return;
  }
  if (apiKey === null) {
    emitError({
      code: "missing_api_key",
      message: `no ${API_KEY_NAME} is configured`,
      recovery: RECOVERY_MISSING_KEY,
    });
    return;
  }

  const depth = args.verb === "ask" ? args.depth : null;
  const holdUsd =
    args.verb === "ask" ? DEPTH_HOLD_USD[args.depth] : FIND_HOLD_USD;

  let held: ReturnType<typeof reserveSpend>;
  try {
    held = reserve({ verb: args.verb, depth, holdUsd }, ledgerDeps);
  } catch (err) {
    emitError({
      code: "ledger_unavailable",
      message: `the cost ledger is unusable: ${err instanceof Error ? err.message : String(err)}`,
      recovery: RECOVERY_LEDGER,
    });
    return;
  }
  if (!held.ok) {
    emitError({
      code: "budget_exceeded",
      message: `the ${held.blocked.name} search budget window is spent`,
      recovery: RECOVERY_BUDGET,
      details: {
        blocked_window: held.blocked.name,
        spent_usd: held.blocked.spentUsd,
        hold_usd: held.holdUsd,
        cap_usd: held.blocked.capUsd,
        window_hours: held.blocked.windowHours,
      },
    });
    return;
  }
  for (const line of spendWarnings(held.windows)) deps.writeStderr(line);
  const reservationId = held.id;

  const spec: PostSpec =
    args.verb === "ask"
      ? {
          url: AGENT_ENDPOINT,
          apiKey,
          body: buildAgentRequestBody({
            depth: args.depth,
            input: args.input,
            filters: args.filters,
          }),
          timeoutMs: args.timeoutMs,
        }
      : {
          url: SEARCH_ENDPOINT,
          apiKey,
          body: buildSearchRequestBody({
            query: args.query,
            limit: args.limit,
            filters: args.filters,
          }),
          timeoutMs: args.timeoutMs,
        };

  // An unexpected throw out of the transport is classified AMBIGUOUS rather than
  // allowed to escape: a crash after the hold was taken would leave an open
  // reservation with no diagnosis, and nothing here can prove the request went
  // unserved.
  let outcome: TransportOutcome;
  try {
    outcome = await post(spec);
  } catch (err) {
    outcome = {
      kind: "ambiguous",
      message: `the request failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: 0,
      attempts: 1,
    };
  }

  // A settle failure must not swallow a result the human already paid for, nor
  // pretend the accounting landed. The unsettled reservation keeps charging its
  // hold — the conservative side — and the fault is named on stderr.
  const closeOut = (settlement: Settlement): void => {
    try {
      settle(
        settlementFor(args.verb, depth, reservationId, outcome, settlement),
        ledgerDeps,
      );
    } catch (err) {
      deps.writeStderr(
        `agentsearch: the call completed but its ledger settle failed; the ` +
          `budget hold stands until it ages out: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
      );
    }
  };

  if (
    outcome.kind !== "response" ||
    outcome.status < 200 ||
    outcome.status >= 300
  ) {
    const classified = classifyTransport(outcome);
    closeOut({
      ...EMPTY_SETTLEMENT,
      status: classified.status,
      released: classified.released,
    });
    emitError(transportProblem(outcome, classified));
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(outcome.body);
  } catch {
    closeOut({
      ...EMPTY_SETTLEMENT,
      status: "unparseable_body",
      released: false,
    });
    emitError({
      code: "malformed_response",
      message: "the provider answered HTTP 200 with a body that is not JSON",
      recovery: RECOVERY_AMBIGUOUS,
      details: { retry_safe: false, latency_ms: outcome.latencyMs },
    });
    return;
  }

  if (args.verb === "ask") {
    const parsed = parseAgentResponse(body, args.depth);
    if (!parsed.ok) {
      closeOut({
        ...EMPTY_SETTLEMENT,
        status: parsed.status,
        released: false,
        costUsd: parsed.cost_usd,
        costStatus: parsed.cost_usd === null ? "unavailable" : "measured",
        responseId: parsed.response_id,
      });
      emitError({
        code: parsed.code,
        message: parsed.message,
        recovery: RECOVERY_AMBIGUOUS,
        details: { ...parsed.details, retry_safe: false },
      });
      return;
    }
    const payload: AskPayload = parsed.payload;
    // Recorded, never scored: the ledger carries how many inline markers the
    // answer used and how many resolved to nothing, so a caller can audit the
    // evidence chain without this verb inventing a confidence number for it.
    const citations = auditCitations(payload.answer, payload.sources);
    closeOut({
      status: "completed",
      released: false,
      model: payload.usage.model,
      inputTokens: payload.usage.input_tokens,
      outputTokens: payload.usage.output_tokens,
      toolCalls: payload.usage.tool_calls,
      sourceCount: payload.sources.length,
      citationRefCount: citations.refs.length,
      unresolvedRefCount: citations.unresolved.length,
      costUsd: payload.usage.cost_usd,
      costStatus: payload.usage.cost_status,
      responseId: payload.usage.response_id,
    });
    emitEnvelopeFormatted(
      successEnvelope(SEARCH_SCHEMA_VERSION, payload),
      deps,
      args.format,
    );
    return;
  }

  const parsed = parseSearchResponse(body);
  if (!parsed.ok) {
    closeOut({
      ...EMPTY_SETTLEMENT,
      status: parsed.status,
      released: false,
      costUsd: parsed.cost_usd,
      costStatus: parsed.cost_usd === null ? "unavailable" : "measured",
      responseId: parsed.response_id,
    });
    emitError({
      code: parsed.code,
      message: parsed.message,
      recovery: RECOVERY_AMBIGUOUS,
      details: { ...parsed.details, retry_safe: false },
    });
    return;
  }
  const payload: FindPayload = parsed.payload;
  closeOut({
    ...EMPTY_SETTLEMENT,
    status: "completed",
    released: false,
    sourceCount: payload.hits.length,
    costUsd: payload.usage.cost_usd,
    costStatus: payload.usage.cost_status,
    responseId: payload.usage.response_id,
  });
  emitEnvelopeFormatted(
    successEnvelope(SEARCH_SCHEMA_VERSION, payload),
    deps,
    args.format,
  );
}

export async function main(argv: string[]): Promise<void> {
  const writeStdout = (s: string): void => {
    process.stdout.write(s);
  };
  const writeStderr = (s: string): void => {
    process.stderr.write(s);
  };
  const exit: (code: number) => never = (code) => process.exit(code);

  const parsed = parseSearchArgs(argv);
  if (!parsed.ok) {
    if (parsed.kind === "help") {
      writeStdout(HELP);
      return;
    }
    if (parsed.kind === "agent-help") {
      writeStdout(AGENT_HELP);
      return;
    }
    writeStderr(`agentsearch: ${parsed.message}\n\n${HELP}`);
    exit(2);
  }
  await runSearchCommand(parsed.args, { writeStdout, writeStderr, exit });
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
