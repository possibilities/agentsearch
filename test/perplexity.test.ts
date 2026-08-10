/**
 * Request shaping + response parsing for `agentsearch`. Every case is pure —
 * no network, no filesystem, no clock — because the two shaping invariants under
 * test (a filter-free `ask` sends no `tools`, and no path ever sends
 * `instructions`) are what keep a paid preset's own decomposition workflow
 * intact.
 *
 * Cost figures are never asserted as fixed amounts: presets are dynamic, so the
 * assertions pin that cost/model/status fields are PRESENT and parse, never what
 * they equal.
 */

import { describe, expect, test } from "bun:test";
import {
  auditCitations,
  buildAgentRequestBody,
  buildSearchRequestBody,
  canonicalUrl,
  countToolCalls,
  DEFAULT_SEARCH_DEPTH,
  ESCALATION_SEARCH_DEPTH,
  MAX_DOMAIN_ENTRIES,
  parseAgentResponse,
  parseDomainFilter,
  parseSearchResponse,
  SEARCH_DEPTHS,
  type SearchFilters,
} from "../src/perplexity";

const NO_FILTERS: SearchFilters = { recency: null, domains: [] };

describe("depth default", () => {
  test("is low — the constant nothing else may raise", () => {
    expect(DEFAULT_SEARCH_DEPTH).toBe("low");
  });

  test("escalates to medium, a strictly deeper preset", () => {
    expect(ESCALATION_SEARCH_DEPTH).toBe("medium");
    expect(SEARCH_DEPTHS.indexOf(ESCALATION_SEARCH_DEPTH)).toBeGreaterThan(
      SEARCH_DEPTHS.indexOf(DEFAULT_SEARCH_DEPTH),
    );
  });
});

describe("auditCitations", () => {
  // A provider id in the hundreds beside a citation ordinal of 1 — the real
  // shape observed live, and the pair the audit must never confuse.
  const sources = [
    {
      ref: "108",
      cited_as: 1,
      url: "https://a",
      title: null,
      published_at: null,
      updated_at: null,
    },
    {
      ref: "109",
      cited_as: null,
      url: "https://b",
      title: null,
      published_at: null,
      updated_at: null,
    },
  ];

  test("an answer with no markers audits clean and empty", () => {
    // These presets do not reliably write inline markers; that is not a defect.
    expect(auditCitations("A plain answer with no markers.", sources)).toEqual({
      refs: [],
      unresolved: [],
    });
  });

  test("resolves a marker against the citation ordinal, not the provider id", () => {
    expect(auditCitations("Grounded [1].", sources)).toEqual({
      refs: ["1"],
      unresolved: [],
    });
  });

  test("a provider id is NOT a citation reference", () => {
    // The regression this whole shape exists to prevent: auditing markers
    // against `ref` reported every marker on every real call unresolved.
    const audit = auditCitations("Grounded [108].", sources);
    expect(audit.unresolved).toEqual(["108"]);
  });

  test("an uncited source lends no ordinal to resolve against", () => {
    expect(auditCitations("Claimed [2].", sources).unresolved).toEqual(["2"]);
  });

  test("a prefixed marker resolves on its numeric tail", () => {
    expect(auditCitations("Grounded [web:1].", sources).unresolved).toEqual([]);
  });

  test("flags a marker that resolves to no cited source", () => {
    const audit = auditCitations("Claimed [9] and [1].", sources);
    expect([...audit.refs].sort()).toEqual(["1", "9"]);
    expect(audit.unresolved).toEqual(["9"]);
  });

  test("counts distinct markers, not occurrences", () => {
    expect(auditCitations("[1] and again [1].", sources).refs).toEqual(["1"]);
  });
});

describe("buildAgentRequestBody", () => {
  test("a filter-free ask sends preset + input and NOTHING else", () => {
    const body = buildAgentRequestBody({
      depth: "low",
      input: "why is the sky blue",
      filters: NO_FILTERS,
    });
    // An empty or partial `tools` array would override the preset's dynamic
    // bundle; the absent key is the whole point.
    expect(Object.keys(body).sort()).toEqual(["input", "preset"]);
    expect(body.preset).toBe("low");
    expect(body.input).toBe("why is the sky blue");
  });

  test("filters ride inside tools[].filters, never at the top level", () => {
    const body = buildAgentRequestBody({
      depth: "medium",
      input: "q",
      filters: { recency: "week", domains: ["a.com", "b.com"] },
    });
    expect(body.tools).toEqual([
      {
        type: "web_search",
        filters: {
          search_recency_filter: "week",
          search_domain_filter: ["a.com", "b.com"],
        },
      },
    ]);
    expect(body.search_recency_filter).toBeUndefined();
    expect(body.search_domain_filter).toBeUndefined();
  });

  test("one filter alone still carries only that filter", () => {
    const body = buildAgentRequestBody({
      depth: "fast",
      input: "q",
      filters: { recency: "day", domains: [] },
    });
    const tools = body.tools as Array<{ filters: Record<string, unknown> }>;
    expect(Object.keys(tools[0]?.filters ?? {})).toEqual([
      "search_recency_filter",
    ]);
  });

  test("no shape ever carries a top-level instructions key", () => {
    for (const filters of [
      NO_FILTERS,
      { recency: "hour", domains: ["x.com"] } as SearchFilters,
    ]) {
      const body = buildAgentRequestBody({ depth: "low", input: "q", filters });
      expect("instructions" in body).toBe(false);
    }
  });

  test("the question is sent verbatim, never pre-shortened", () => {
    const long =
      "how do X and Y interact under Z, and what changed in the last year, " +
      "and which of the two is cheaper at scale";
    const body = buildAgentRequestBody({
      depth: "low",
      input: long,
      filters: NO_FILTERS,
    });
    expect(body.input).toBe(long);
  });
});

describe("buildSearchRequestBody", () => {
  test("carries query, max_results, and the per-page token budget", () => {
    const body = buildSearchRequestBody({
      query: "bun sqlite wal",
      limit: 5,
      filters: NO_FILTERS,
    });
    expect(body.query).toBe("bun sqlite wal");
    expect(body.max_results).toBe(5);
    expect(body.max_tokens_per_page).toBe(512);
  });

  test("filters sit at the top level for this endpoint", () => {
    const body = buildSearchRequestBody({
      query: "q",
      limit: 3,
      filters: { recency: "month", domains: ["-reddit.com"] },
    });
    expect(body.search_recency_filter).toBe("month");
    expect(body.search_domain_filter).toEqual(["-reddit.com"]);
  });
});

describe("parseDomainFilter", () => {
  test("flattens repeated and comma-separated values", () => {
    const parsed = parseDomainFilter(["a.com,b.com", " c.com "]);
    expect(parsed).toMatchObject({
      ok: true,
      entries: ["a.com", "b.com", "c.com"],
      mode: "allow",
    });
  });

  test("an all-prefixed list is a denylist", () => {
    expect(parseDomainFilter(["-a.com", "-b.com"])).toMatchObject({
      ok: true,
      mode: "deny",
    });
  });

  test("rejects a mixed allow + deny list", () => {
    const parsed = parseDomainFilter(["a.com", "-b.com"]);
    expect(parsed.ok).toBe(false);
  });

  test("rejects more than the entry ceiling", () => {
    const many = Array.from(
      { length: MAX_DOMAIN_ENTRIES + 1 },
      (_v, i) => `d${i}.com`,
    );
    const parsed = parseDomainFilter(many);
    expect(parsed.ok).toBe(false);
  });

  test("rejects an empty entry", () => {
    expect(parseDomainFilter(["a.com", "-"]).ok).toBe(false);
  });

  test("no entries is not a filter at all", () => {
    expect(parseDomainFilter([])).toMatchObject({ ok: true, mode: "none" });
  });
});

describe("canonicalUrl", () => {
  test("normalizes case, trailing slash, and fragment", () => {
    expect(canonicalUrl("HTTPS://Example.COM/a/")).toBe(
      canonicalUrl("https://example.com/a#section"),
    );
  });

  test("keeps a query string — it often selects the document", () => {
    expect(canonicalUrl("https://x.com/p?id=1")).not.toBe(
      canonicalUrl("https://x.com/p?id=2"),
    );
  });

  test("an unparseable value falls back to itself", () => {
    expect(canonicalUrl("  not a url  ")).toBe("not a url");
  });
});

describe("countToolCalls", () => {
  test("counts one invocation per tool-result entry", () => {
    expect(
      countToolCalls(
        [
          { type: "search_results", results: [{ url: "https://a" }] },
          { type: "search_results", results: [{ url: "https://b" }] },
          { type: "fetch_url_results", results: [{ url: "https://c" }] },
          { type: "message", content: [{ text: "hi" }] },
          { type: "reasoning" },
        ],
        undefined,
      ),
    ).toEqual({ search_web: 2, fetch_url: 1 });
  });

  test("floors a billed tool that emitted no result entry at one", () => {
    expect(
      countToolCalls([{ type: "message" }], {
        cost: { tool_calls_cost_details: { search_web: 0.0025 } },
      }),
    ).toEqual({ search_web: 1 });
  });

  test("an observed count is never overwritten by the billing floor", () => {
    expect(
      countToolCalls(
        [
          { type: "search_results", results: [] },
          { type: "search_results", results: [] },
        ],
        { cost: { tool_calls_cost_details: { search_web: 0.005 } } },
      ),
    ).toEqual({ search_web: 2 });
  });

  test("an unrecognized <x>_results entry is attributed, not dropped", () => {
    expect(
      countToolCalls([{ type: "code_exec_results", results: [] }], undefined),
    ).toEqual({ code_exec: 1 });
  });

  test("a non-array output with no billing counts nothing", () => {
    expect(countToolCalls(undefined, undefined)).toEqual({});
  });
});

/**
 * A completed Agent response in the shape the provider ACTUALLY returns: a
 * tool-result entry is typed `<tool>_results` and carries its rows at
 * `.results` — not at a field named after itself — and each row carries
 * `id`/`url`/`title`/`last_updated`, plus `snippet`/`source` that must not
 * reach the payload. Tool billing is reported separately under
 * `usage.cost.tool_calls_cost_details`.
 */
function agentResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "resp_1",
    status: "completed",
    model: "some/dynamic-model",
    output: [
      {
        type: "search_results",
        results: [
          {
            id: 92,
            url: "https://example.com/a",
            title: "A",
            snippet: "retrieved page text that must not reach the payload",
            source: "web",
            last_updated: "2020-02-02",
          },
          { id: 93, url: "https://example.com/b", title: "B" },
        ],
      },
      {
        type: "fetch_url_results",
        results: [
          { id: 96, url: "https://example.com/a", last_updated: "later" },
        ],
      },
      // Ids are the provider's own, allocated across the run and gappy — the
      // live shape (92…160 in one response), never a 1-based ordinal. The
      // citation channel is `annotations`, beside the text and not inside it.
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "The answer [1].",
            annotations: [
              {
                type: "url_citation",
                start_index: 11,
                end_index: 14,
                url: "https://example.com/b",
                title: "B",
              },
            ],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 1234,
      output_tokens: 567,
      cost: {
        total_cost: 0.00948,
        tool_calls_cost_details: { search_web: 0.0025, fetch_url: 0.0005 },
      },
    },
    ...overrides,
  };
}

describe("parseAgentResponse", () => {
  test("concatenates message text and preserves the answer's own markers", () => {
    const parsed = parseAgentResponse(agentResponse(), "low");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.answer).toBe("The answer [1].");
    // Provider ids, verbatim and unrenumbered — they are not citation refs.
    expect(parsed.payload.sources.map((s) => s.ref)).toEqual(["92", "93"]);
  });

  test("numbers sources by the answer's citation order, not retrieval order", () => {
    const parsed = parseAgentResponse(agentResponse(), "low");
    if (!parsed.ok) throw new Error("expected a parsed payload");
    // The answer cites the SECOND retrieved page, so that page is citation 1.
    expect(parsed.payload.sources.map((s) => [s.url, s.cited_as])).toEqual([
      ["https://example.com/a", null],
      ["https://example.com/b", 1],
    ]);
  });

  test("the answer's markers resolve against the payload it ships with", () => {
    // The end-to-end regression: for every real call ever made, every marker
    // audited unresolved because markers were compared against provider ids.
    const parsed = parseAgentResponse(agentResponse(), "low");
    if (!parsed.ok) throw new Error("expected a parsed payload");
    const audit = auditCitations(parsed.payload.answer, parsed.payload.sources);
    expect(audit.refs).toEqual(["1"]);
    expect(audit.unresolved).toEqual([]);
  });

  test("a cited page missing from the tool results is carried, not dropped", () => {
    const parsed = parseAgentResponse(
      agentResponse({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Grounded [1].",
                annotations: [
                  {
                    type: "url_citation",
                    start_index: 9,
                    end_index: 12,
                    url: "https://example.com/only-cited",
                    title: "Only cited",
                  },
                ],
              },
            ],
          },
        ],
      }),
      "low",
    );
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(parsed.payload.sources).toEqual([
      {
        ref: null,
        cited_as: 1,
        url: "https://example.com/only-cited",
        title: "Only cited",
        published_at: null,
        updated_at: null,
      },
    ]);
  });

  test("a URL cited twice keeps its first ordinal", () => {
    const annotation = (url: string) => ({
      type: "url_citation",
      start_index: 0,
      end_index: 1,
      url,
      title: null,
    });
    const parsed = parseAgentResponse(
      agentResponse({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "[1] then [2] then [1].",
                annotations: [
                  annotation("https://example.com/x"),
                  annotation("https://example.com/y"),
                  annotation("https://example.com/x#again"),
                ],
              },
            ],
          },
        ],
      }),
      "low",
    );
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(parsed.payload.sources.map((s) => s.cited_as)).toEqual([1, 2]);
  });

  test("an answer with no annotations leaves every source uncited", () => {
    // Some presets cite nothing. That is not a defect, and it must not invent
    // ordinals that an inline marker would then appear to resolve against.
    const parsed = parseAgentResponse(
      agentResponse({
        output: [
          {
            type: "search_results",
            results: [{ id: 92, url: "https://example.com/a", title: "A" }],
          },
          { type: "message", content: [{ text: "No markers here." }] },
        ],
      }),
      "low",
    );
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(parsed.payload.sources.map((s) => s.cited_as)).toEqual([null]);
  });

  test("folds search and fetch results into one list deduped by URL", () => {
    const parsed = parseAgentResponse(agentResponse(), "low");
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(parsed.payload.sources).toHaveLength(2);
    // The fetch leg's update stamp merges into the duplicate it shares a URL with.
    expect(parsed.payload.sources[0]?.updated_at).toBe("2020-02-02");
  });

  test("usage carries cost, model, tokens, tool counts, and the response id", () => {
    const parsed = parseAgentResponse(agentResponse(), "medium");
    if (!parsed.ok) throw new Error("expected a parsed payload");
    const usage = parsed.payload.usage;
    // Presets are dynamic: assert the fields exist and parse, never their values.
    expect(typeof usage.cost_usd).toBe("number");
    expect(usage.cost_status).toBe("measured");
    expect(usage.depth).toBe("medium");
    expect(typeof usage.model).toBe("string");
    expect(usage.input_tokens).toBe(1234);
    expect(usage.output_tokens).toBe(567);
    expect(usage.tool_calls).toEqual({ search_web: 1, fetch_url: 1 });
    expect(usage.response_id).toBe("resp_1");
  });

  test("a missing cost is an accounting fault, never a zero", () => {
    const parsed = parseAgentResponse(
      agentResponse({ usage: { input_tokens: 1 } }),
      "low",
    );
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(parsed.payload.usage.cost_usd).toBeNull();
    expect(parsed.payload.usage.cost_status).toBe("unavailable");
  });

  test("no snippets, reasoning traces, or raw payload leak into a source", () => {
    const parsed = parseAgentResponse(agentResponse(), "low");
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(Object.keys(parsed.payload.sources[0] ?? {}).sort()).toEqual([
      "cited_as",
      "published_at",
      "ref",
      "title",
      "updated_at",
      "url",
    ]);
    // The retrieved page text is real context cost and is dropped outright.
    expect(JSON.stringify(parsed.payload)).not.toContain("retrieved page text");
  });

  test("a searched response never comes back with an empty source set", () => {
    // The regression that made `ask` claim a grounded answer while presenting
    // no evidence: results live at `.results` on a `<tool>_results` entry.
    const parsed = parseAgentResponse(agentResponse(), "low");
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(parsed.payload.sources.length).toBeGreaterThan(0);
    expect(Object.keys(parsed.payload.usage.tool_calls).length).toBeGreaterThan(
      0,
    );
  });

  for (const status of ["failed", "cancelled", "incomplete", "unknown"]) {
    test(`status '${status}' is a failure even on HTTP 200`, () => {
      const parsed = parseAgentResponse(agentResponse({ status }), "low");
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.code).toBe("answer_incomplete");
      // The id + known cost survive so the spend stays accountable.
      expect(parsed.response_id).toBe("resp_1");
      expect(parsed.details.cost_usd).toBe(0.00948);
    });
  }

  test("a completed run with no answer text is a failure, not an empty success", () => {
    const parsed = parseAgentResponse(agentResponse({ output: [] }), "low");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("malformed_response");
  });

  test("a non-object body is a malformed response", () => {
    expect(parseAgentResponse("nope", "low").ok).toBe(false);
  });
});

describe("parseSearchResponse", () => {
  test("keeps snippet and drops the duplicate summary field", () => {
    const parsed = parseSearchResponse({
      id: "srch_1",
      results: [
        {
          url: "https://example.com/x",
          title: "X",
          snippet: "the snippet",
          summary: "the duplicate",
          last_updated: "yesterday",
        },
      ],
    });
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(parsed.payload.hits[0]).toEqual({
      url: "https://example.com/x",
      title: "X",
      domain: "example.com",
      snippet: "the snippet",
      last_updated: "yesterday",
    });
    expect(parsed.payload.total).toBe(1);
    expect(parsed.payload.usage.response_id).toBe("srch_1");
  });

  test("dedupes hits by canonical URL", () => {
    const parsed = parseSearchResponse({
      results: [
        { url: "https://example.com/x" },
        { url: "https://example.com/x/" },
      ],
    });
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(parsed.payload.total).toBe(1);
  });

  test("a response without a results array is malformed", () => {
    expect(parseSearchResponse({ id: "x" }).ok).toBe(false);
  });

  test("a cost-free response reports unavailable, never zero", () => {
    const parsed = parseSearchResponse({ results: [] });
    if (!parsed.ok) throw new Error("expected a parsed payload");
    expect(parsed.payload.usage.cost_usd).toBeNull();
    expect(parsed.payload.usage.cost_status).toBe("unavailable");
  });
});
