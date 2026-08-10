/**
 * Request shaping + response parsing for the two Perplexity endpoints behind
 * `agentsearch`: the Agent API (`ask` — a synthesized, cited answer) and the
 * Search API (`find` — ranked hits).
 *
 * PURE: this module builds request bodies and reads response payloads. It opens
 * no socket, reads no environment, and touches no filesystem — the transport
 * lives in `transport.ts`, the spend accounting in `ledger.ts` — so every shaping
 * and parsing rule below is exercised by an in-process test with zero network.
 *
 * Two shaping invariants carry real money:
 *
 *  1. **A filter-free `ask` omits `tools` entirely.** The `preset` selects a
 *     dynamic tool bundle (its own query-decomposition workflow, and at `low`
 *     and above a `fetch_url` leg); sending an empty or partial `tools` array
 *     overrides that bundle. Filters therefore ride INSIDE
 *     `tools[].filters`, never at the top level.
 *  2. **Never send a top-level `instructions`.** With a preset, `instructions`
 *     supplants the preset's tuned system prompt — including the decomposition
 *     workflow that makes a long multi-clause question worth asking as one call.
 *     There is deliberately no flag, env var, or config that can set it.
 */

/** How much research an `ask` buys. The preset is dynamic on the provider side:
 *  it selects the model AND the tool bundle, so neither is a stable contract and
 *  both are reported back in `usage`. */
export type SearchDepth = "fast" | "low" | "medium" | "high";

/** Every accepted `--depth`, in ascending cost order. */
export const SEARCH_DEPTHS = ["fast", "low", "medium", "high"] as const;

/**
 * The default depth. A CONSTANT, read by nothing but the flag resolver: no env
 * var and no config key may raise the implicit depth above this.
 *
 * `low` is the default because it answers most questions COMPLETELY, including
 * dense multi-clause ones. `fast` is an opt-DOWN for a single fact or a
 * definition — NOT a general cheaper mode: on a multi-part question it drops
 * facets, so the re-run it forces costs more per answered question than
 * starting at `low` would have.
 */
export const DEFAULT_SEARCH_DEPTH: SearchDepth = "low";

/** Where a caller escalates when `low` leaves a request underserved. */
export const ESCALATION_SEARCH_DEPTH: SearchDepth = "medium";

/** Depths that additionally require an explicit `--allow-expensive`. */
export const GUARDED_DEPTHS: ReadonlySet<SearchDepth> = new Set<SearchDepth>([
  "high",
]);

/** The relative retrieval windows the provider accepts. */
export type Recency = "hour" | "day" | "week" | "month" | "year";

export const RECENCY_WINDOWS = [
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;

/** Provider ceiling on `search_domain_filter` entries. */
export const MAX_DOMAIN_ENTRIES = 20;

/** Default hits for `find` — deliberately small: a caller that wants breadth
 *  asks for it, and every hit is paid retrieval. */
export const DEFAULT_FIND_LIMIT = 5;

/** Ceiling on `find --limit` — one flag's bounds, kept beside its default. */
export const MAX_FIND_LIMIT = 20;

/** Per-page token budget for a `find` snippet. */
export const FIND_MAX_TOKENS_PER_PAGE = 512;

export const AGENT_ENDPOINT = "https://api.perplexity.ai/v1/agent";
export const SEARCH_ENDPOINT = "https://api.perplexity.ai/search";

export function isSearchDepth(value: string): value is SearchDepth {
  return (SEARCH_DEPTHS as readonly string[]).includes(value);
}

export function isRecency(value: string): value is Recency {
  return (RECENCY_WINDOWS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A result's provider-side id, preserved verbatim as text.
 *
 *  This is the PROVIDER'S OWN identifier for a retrieved page, allocated across
 *  the whole run — observed live as a gappy integer sequence (92, 93, 96, …,
 *  160 within a single response). It is deliberately NOT what an answer's
 *  inline `[n]` marker refers to: markers are small per-answer ordinals, and
 *  comparing the two numbering spaces resolves nothing. `cited_as` carries the
 *  ordinal a marker actually indexes. */
function refValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

// ── domain filter ────────────────────────────────────────────────────────────

/** A validated `--domains` selection. `mode` is `none` when the caller passed
 *  no entries — the shaping layer then omits the key entirely. */
export type DomainFilter =
  | {
      readonly ok: true;
      readonly entries: readonly string[];
      readonly mode: "allow" | "deny" | "none";
    }
  | { readonly ok: false; readonly message: string };

/**
 * Flatten and validate the raw `--domains` values (repeatable, and each value
 * may itself be comma-separated). The provider accepts an allowlist OR a
 * denylist — every entry prefixed `-` — never a mix, and at most
 * {@link MAX_DOMAIN_ENTRIES} entries. Both faults are caught HERE rather than
 * spent on a round trip the server rejects.
 */
export function parseDomainFilter(raw: readonly string[]): DomainFilter {
  const entries: string[] = [];
  for (const value of raw) {
    for (const piece of value.split(",")) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) entries.push(trimmed);
    }
  }
  if (entries.length === 0) return { ok: true, entries: [], mode: "none" };
  if (entries.length > MAX_DOMAIN_ENTRIES) {
    return {
      ok: false,
      message: `--domains accepts at most ${MAX_DOMAIN_ENTRIES} entries (got ${entries.length})`,
    };
  }
  const denied = entries.filter((entry) => entry.startsWith("-"));
  if (denied.length > 0 && denied.length !== entries.length) {
    return {
      ok: false,
      message:
        "--domains is an allowlist OR a denylist (every entry prefixed '-'), never both",
    };
  }
  const bare = entries.find(
    (entry) => entry === "-" || entry.replace(/^-/, "").length === 0,
  );
  if (bare !== undefined) {
    return { ok: false, message: "--domains carries an empty domain entry" };
  }
  return {
    ok: true,
    entries,
    mode: denied.length > 0 ? "deny" : "allow",
  };
}

// ── request shaping ──────────────────────────────────────────────────────────

/** The retrieval filters both verbs share. */
export interface SearchFilters {
  readonly recency: Recency | null;
  readonly domains: readonly string[];
}

/** True when the caller asked for any retrieval filter at all. */
export function hasFilters(filters: SearchFilters): boolean {
  return filters.recency !== null || filters.domains.length > 0;
}

function filterBody(filters: SearchFilters): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (filters.recency !== null) body.search_recency_filter = filters.recency;
  if (filters.domains.length > 0)
    body.search_domain_filter = [...filters.domains];
  return body;
}

/**
 * The `POST /v1/agent` body. `preset` + `input` and nothing else when there are
 * no filters — an absent `tools` key leaves the preset's dynamic tool bundle
 * intact. With filters, exactly one `web_search` tool entry carries them; the
 * preset's other legs stay enabled.
 */
export function buildAgentRequestBody(spec: {
  readonly depth: SearchDepth;
  readonly input: string;
  readonly filters: SearchFilters;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    preset: spec.depth,
    input: spec.input,
  };
  if (hasFilters(spec.filters)) {
    body.tools = [{ type: "web_search", filters: filterBody(spec.filters) }];
  }
  return body;
}

/** The `POST /search` body. Filters sit at the top level here — this endpoint
 *  has no preset and no tool bundle to preserve. */
export function buildSearchRequestBody(spec: {
  readonly query: string;
  readonly limit: number;
  readonly filters: SearchFilters;
}): Record<string, unknown> {
  return {
    query: spec.query,
    max_results: spec.limit,
    max_tokens_per_page: FIND_MAX_TOKENS_PER_PAGE,
    ...filterBody(spec.filters),
  };
}

// ── response payloads ────────────────────────────────────────────────────────

/**
 * One retrieved page behind an answer.
 *
 * Two distinct identifiers, and conflating them is the defect this shape exists
 * to prevent:
 *
 *  - `ref` — the PROVIDER's result id, verbatim. Stable across the run, useful
 *    for correlating a page against the raw response, and meaningless as a
 *    citation reference.
 *  - `cited_as` — the 1-based ordinal this source holds in the answer's OWN
 *    citation list, derived from the response's `url_citation` annotations in
 *    order of first citation. This is the space an inline `[2]` indexes. `null`
 *    means the page was retrieved but never cited — the common case, since the
 *    evidence set is deliberately wider than the bibliography.
 */
export interface AskSource {
  ref: string | null;
  cited_as: number | null;
  url: string;
  title: string | null;
  published_at: string | null;
  updated_at: string | null;
}

/** Whether a cost figure was read off the response or is missing. `unavailable`
 *  is an accounting fault to surface, never a zero to swallow. */
export type CostStatus = "measured" | "unavailable";

export interface AskUsage {
  cost_usd: number | null;
  cost_status: CostStatus;
  depth: SearchDepth;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool_calls: Record<string, number>;
  response_id: string | null;
}

/** The `ask` payload: the answer, its deduped sources, and what it cost. No
 *  snippets, no reasoning trace, no raw provider payload — the compact shape IS
 *  the cost lever for the agent reading it. */
export interface AskPayload {
  answer: string;
  sources: AskSource[];
  usage: AskUsage;
}

export interface FindHit {
  url: string;
  title: string | null;
  domain: string | null;
  snippet: string | null;
  last_updated: string | null;
}

export interface FindPayload {
  hits: FindHit[];
  total: number;
  usage: {
    cost_usd: number | null;
    cost_status: CostStatus;
    response_id: string | null;
  };
}

/** A parse outcome. A non-`completed` provider status is a FAILURE even on HTTP
 *  200: `details` preserves the response id and whatever cost is known so the
 *  spend is still accountable. */
export type ParseResult<P> =
  | { readonly ok: true; readonly payload: P }
  | {
      readonly ok: false;
      readonly code: "answer_incomplete" | "malformed_response";
      readonly message: string;
      readonly details: Record<string, unknown>;
      readonly cost_usd: number | null;
      readonly response_id: string | null;
      readonly status: string;
    };

/**
 * Canonical form of a URL for dedupe: lowercased scheme + host, fragment
 * dropped, a bare trailing slash removed. Query strings are KEPT — they often
 * select the actual document. An unparseable value falls back to its trimmed
 * self so a malformed URL still dedupes against an identical twin.
 */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return raw.trim();
  }
}

/** The host of a URL, lowercased, or null when it will not parse. */
export function urlDomain(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function readCost(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const cost = usage.cost;
  if (isRecord(cost)) {
    const total = num(cost.total_cost);
    if (total !== null) return total;
  }
  return num(usage.total_cost);
}

function costStatus(cost: number | null): CostStatus {
  return cost === null ? "unavailable" : "measured";
}

/**
 * A tool-result entry in `output[]` is typed `<something>_results` and carries
 * its rows at `.results`. This table names the TOOL behind each such entry —
 * the entry type and the tool name differ (`search_results` is produced by
 * `search_web`), so a mechanical suffix strip would mislabel them.
 */
const RESULT_ENTRY_TOOLS: Readonly<Record<string, string>> = {
  search_results: "search_web",
  fetch_url_results: "fetch_url",
};

/** The tool behind one `output[]` entry, or null when the entry is not a tool
 *  result. An unrecognized `<x>_results` entry that still carries a `.results`
 *  array is attributed to `<x>` rather than dropped, so a preset that grows a
 *  new tool surfaces it instead of silently vanishing from the tally. */
function entryTool(entry: Record<string, unknown>): string | null {
  const type = typeof entry.type === "string" ? entry.type : null;
  if (type === null) return null;
  const known = RESULT_ENTRY_TOOLS[type];
  if (known !== undefined) return known;
  if (type.endsWith("_results") && Array.isArray(entry.results)) {
    return type.slice(0, -"_results".length);
  }
  return null;
}

/** Fold one entry's `.results` rows into the deduped source list, merging
 *  fields a later duplicate fills in (a fetched page often carries an update
 *  stamp the search hit lacked). `snippet` and `source` are deliberately NOT
 *  carried: the payload is evidence pointers, not retrieved page text. */
function collectSources(raw: unknown, into: Map<string, AskSource>): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const url = str(item.url);
    if (url === null) continue;
    const key = canonicalUrl(url);
    const next: AskSource = {
      ref: refValue(item.id),
      cited_as: null,
      url,
      title: str(item.title),
      published_at: str(item.date),
      updated_at: str(item.last_updated),
    };
    const existing = into.get(key);
    if (existing === undefined) {
      into.set(key, next);
      continue;
    }
    existing.ref = existing.ref ?? next.ref;
    existing.title = existing.title ?? next.title;
    existing.published_at = existing.published_at ?? next.published_at;
    existing.updated_at = existing.updated_at ?? next.updated_at;
  }
}

/**
 * Count the tool legs the preset ran, keyed by tool name.
 *
 * Two sources, deliberately combined. The `output[]` tool-result entries give
 * the OBSERVED invocation count — one entry per call. `usage.cost.
 * tool_calls_cost_details` is authoritative for WHICH tools billed, so a tool
 * that billed while emitting no result entry is floored at 1 rather than
 * reported as absent. Neither source is inflated past what it evidences: an
 * observed count always wins over the floor.
 */
export function countToolCalls(
  output: unknown,
  usage: unknown,
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (Array.isArray(output)) {
    for (const entry of output) {
      if (!isRecord(entry)) continue;
      const tool = entryTool(entry);
      if (tool === null) continue;
      counts[tool] = (counts[tool] ?? 0) + 1;
    }
  }
  const cost = isRecord(usage) ? usage.cost : null;
  const billed = isRecord(cost) ? cost.tool_calls_cost_details : null;
  if (isRecord(billed)) {
    for (const tool of Object.keys(billed)) {
      if ((counts[tool] ?? 0) === 0) counts[tool] = 1;
    }
  }
  return counts;
}

/**
 * One `url_citation` annotation: the provider's REAL citation channel.
 *
 * A message content part carries `annotations[]` alongside its `text`, each
 * binding a character span of the answer to the source URL it came from. This —
 * not a bracket in the prose — is what the API defines as a citation, and it is
 * the only mapping from answer to evidence that does not require guessing.
 */
interface UrlCitation {
  readonly url: string;
  readonly title: string | null;
}

/** Read one content part's `annotations[]`, keeping `url_citation` entries in
 *  the order they appear — that order IS the answer's citation numbering. */
function collectCitations(raw: unknown, into: UrlCitation[]): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (item.type !== "url_citation") continue;
    const url = str(item.url);
    if (url === null) continue;
    into.push({ url, title: str(item.title) });
  }
}

/**
 * Number the sources by the answer's own citation order and fold in any cited
 * page the tool results never carried.
 *
 * The returned list keeps retrieval order — the evidence set is what it always
 * was — and only stamps `cited_as`. A citation whose URL matches no retrieved
 * source is APPENDED rather than dropped: an answer citing evidence the payload
 * does not carry is precisely the fault the audit reports, so the payload has to
 * be able to show it.
 */
function applyCitationOrder(
  sources: Map<string, AskSource>,
  citations: readonly UrlCitation[],
): AskSource[] {
  let ordinal = 0;
  for (const citation of citations) {
    const key = canonicalUrl(citation.url);
    const existing = sources.get(key);
    if (existing !== undefined) {
      // A URL cited more than once keeps the ordinal from its first citation.
      if (existing.cited_as === null) existing.cited_as = ++ordinal;
      continue;
    }
    sources.set(key, {
      ref: null,
      cited_as: ++ordinal,
      url: citation.url,
      title: citation.title,
      published_at: null,
      updated_at: null,
    });
  }
  return [...sources.values()];
}

/** A citation marker in an answer: `[web:2]`, `[fetch:1]`, or a bare `[3]`. */
const CITATION_MARKER = /\[([A-Za-z_]*:?\d+)\]/g;

/** What an answer's inline citation markers resolve to. `unresolved` is the
 *  load-bearing half — a caller checks it to know the answer cited evidence the
 *  payload does not carry. Both are distinct-marker counts, never occurrences. */
export interface CitationAudit {
  readonly refs: readonly string[];
  readonly unresolved: readonly string[];
}

/**
 * Audit an answer's inline citation markers against the citation ordinals the
 * payload carries.
 *
 * Markers are matched against `cited_as`, NOT against `ref`. Those are separate
 * numbering spaces — `ref` is a provider id running into the hundreds within one
 * response, while a marker is a small per-answer ordinal — and auditing one
 * against the other reported every marker unresolved on every call ever made.
 *
 * Purely mechanical: it reports which markers appear and which do not resolve,
 * and derives NO score or verdict from them. An answer that carries no markers
 * audits clean and empty — absence of inline citation is not a defect, it is
 * how some presets write.
 */
export function auditCitations(
  answer: string,
  sources: readonly AskSource[],
): CitationAudit {
  const known = new Set(
    sources
      .map((s) => s.cited_as)
      .filter((n): n is number => n !== null)
      .map((n) => String(n)),
  );
  const refs = new Set<string>();
  for (const match of answer.matchAll(CITATION_MARKER)) {
    const ref = match[1];
    if (ref !== undefined) refs.add(ref);
  }
  return {
    refs: [...refs],
    // A prefixed marker (`[web:2]`) carries the provider's own dialect; only its
    // numeric tail can index the citation list.
    unresolved: [...refs].filter((ref) => !known.has(ref.replace(/^.*:/, ""))),
  };
}

/**
 * Read one Agent API response into the compact `ask` payload.
 *
 * `status` is authoritative and independent of the HTTP code: `failed`,
 * `cancelled`, and `incomplete` all arrive as HTTP 200, and every one of them is
 * an error here — a partial answer is never emitted as a success. A `completed`
 * response with no message text is equally a failure: an empty answer is not an
 * answer.
 */
export function parseAgentResponse(
  raw: unknown,
  depth: SearchDepth,
): ParseResult<AskPayload> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      code: "malformed_response",
      message: "the provider returned a body that is not a JSON object",
      details: {},
      cost_usd: null,
      response_id: null,
      status: "unparseable",
    };
  }
  const responseId = str(raw.id);
  const cost = readCost(raw.usage);
  const status = str(raw.status) ?? "unknown";
  if (status !== "completed") {
    return {
      ok: false,
      code: "answer_incomplete",
      message: `the provider ended the run with status '${status}'`,
      details: {
        status,
        response_id: responseId,
        cost_usd: cost,
        cost_status: costStatus(cost),
        model: str(raw.model),
      },
      cost_usd: cost,
      response_id: responseId,
      status,
    };
  }

  const output = raw.output;
  const chunks: string[] = [];
  const sources = new Map<string, AskSource>();
  const citations: UrlCitation[] = [];
  if (Array.isArray(output)) {
    for (const entry of output) {
      if (!isRecord(entry)) continue;
      if (entry.type === "message" && Array.isArray(entry.content)) {
        for (const part of entry.content) {
          if (!isRecord(part)) continue;
          if (typeof part.text === "string") chunks.push(part.text);
          // The citation channel rides beside the text, not inside it.
          collectCitations(part.annotations, citations);
        }
      }
      // A tool-result entry is typed `<something>_results` and carries its rows
      // at `.results` — the entry type is the container, not the field name.
      if (entryTool(entry) !== null) collectSources(entry.results, sources);
    }
  }
  const answer = chunks.join("");
  if (answer.trim().length === 0) {
    return {
      ok: false,
      code: "malformed_response",
      message: "the provider reported success but carried no answer text",
      details: { status, response_id: responseId, cost_usd: cost },
      cost_usd: cost,
      response_id: responseId,
      status,
    };
  }

  const usageRecord = isRecord(raw.usage) ? raw.usage : {};
  return {
    ok: true,
    payload: {
      answer,
      sources: applyCitationOrder(sources, citations),
      usage: {
        cost_usd: cost,
        cost_status: costStatus(cost),
        depth,
        model: str(raw.model),
        input_tokens: num(usageRecord.input_tokens),
        output_tokens: num(usageRecord.output_tokens),
        tool_calls: countToolCalls(output, raw.usage),
        response_id: responseId,
      },
    },
  };
}

/**
 * Read one Search API response into the compact `find` payload. The endpoint
 * returns a `snippet` alongside a duplicate `summary`; only `snippet` is kept —
 * carrying both doubles the payload an agent pays to read for no new evidence.
 */
export function parseSearchResponse(raw: unknown): ParseResult<FindPayload> {
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    return {
      ok: false,
      code: "malformed_response",
      message: "the provider returned no results array",
      details: {},
      cost_usd: null,
      response_id: isRecord(raw) ? str(raw.id) : null,
      status: "unparseable",
    };
  }
  const hits: FindHit[] = [];
  const seen = new Set<string>();
  for (const item of raw.results) {
    if (!isRecord(item)) continue;
    const url = str(item.url);
    if (url === null) continue;
    const key = canonicalUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      url,
      title: str(item.title),
      domain: urlDomain(url),
      snippet: str(item.snippet),
      last_updated: str(item.last_updated),
    });
  }
  const cost = readCost(raw.usage);
  return {
    ok: true,
    payload: {
      hits,
      total: hits.length,
      usage: {
        cost_usd: cost,
        cost_status: costStatus(cost),
        response_id: str(raw.id),
      },
    },
  };
}
