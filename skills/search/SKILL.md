---
name: search
description: Grounded web research with the agentsearch CLI — synthesized cited answers (ask) or ranked source links (find), retrieved live from the web. Use when the user says "look this up", "search the web", "what's the latest on…", "is that still true"; when a fact postdates your training (releases, versions, prices, docs, an error string you have never seen); or when a claim needs an outside source before you rely on it. Reach for ask when you want the ANSWER, find when you want the LINKS. Every call spends real money against a capped budget — deliberate, never reflexive.
---

# Search — grounded web research

`agentsearch` buys two things from the live web: a synthesized, cited answer
(`ask`) or a ranked list of sources to read yourself (`find`). It is the way
out of your training cutoff — versions, releases, prices, breaking changes,
error strings that did not exist when you were trained, claims a user wants
corroborated.

It is also the one tool here that spends the user's money on every
invocation. There is no free tier, no cache, and no dry run: a call that
reaches the provider is billed whether or not you liked the answer. That
single fact shapes everything below — you get one good call, not five
cheap ones.

Verified against agentsearch 0.1.0. The binary is self-describing; when this
document and the installed CLI disagree, the binary wins — see
[Discovery and drift](#discovery-and-drift).

## Non-negotiables

- **Every `ask` and `find` costs money.** Compose the call before you run it.
  Never invoke either verb to "see what happens", to test that the tool works,
  or to warm up before the real question.
- **Hand `ask` the WHOLE question.** Long, multi-clause, several constraints at
  once. The depth preset decomposes it into parallel retrievals itself.
  Pre-splitting a question into three `ask` calls buys three bills and a worse
  synthesis; pre-shortening it drops the constraints that made the answer
  useful.
- **Never blind-retry a failed call.** These endpoints carry no idempotency
  key, so a retry of an ambiguous failure can bill twice. Read
  `error.details.retry_safe` and act on it.
- **stdout is the envelope, stderr is diagnostics.** Parse stdout as JSON —
  including on failure, where an `ok:false` envelope still lands on stdout with
  exit 1. Budget warnings and ledger faults go to stderr and are never part of
  the result.
- **Depth is an explicit decision, always.** `low` is the default and nothing
  in the environment or config can raise the implicit depth above it. Deeper
  runs are flags you chose to type.
- **Don't pay for what you already have.** A URL whose contents you need is the
  `scrape` skill's job. Something this machine already knows belongs to the
  `brain` skill's local index. Something a past session figured out belongs to
  the `chats` skill. All three are free; check them first.

## Preflight

Everything here is free and instant — none of it sends a paid request:

```bash
agentsearch --agent-help      # the in-binary runbook (this skill is the long form)
agentsearch --help            # flags, exit codes, auth, cost
agentsearch --version
```

Confirm a credential exists before composing a question, so a missing key is
not something you discover mid-task:

```bash
[ -n "$PERPLEXITY_API_KEY" ] \
  || grep -q PERPLEXITY_API_KEY ~/.config/agentsearch/secrets.json 2>/dev/null
```

Auth resolves `PERPLEXITY_API_KEY` from the environment first, then from
`~/.config/agentsearch/secrets.json` (a flat JSON object;
`AGENTSEARCH_CONFIG_DIR` relocates it). The file leg is what makes this work
under hooks and daemons, which inherit no shell profile. A missing key is
caught before any request is shaped, so it costs nothing — but it costs a turn.

To see what has already been spent, read the ledger. It records cost, never
query text:

```bash
tail -n 20 ~/.local/state/agentsearch/search/ledger.jsonl \
  | jq -c 'select(.kind=="settle") | {ts, verb, depth, status, cost_usd}'
```

## The two verbs

| | `ask` | `find` |
|---|---|---|
| Buys | a written, cited answer | ranked hits: url, title, snippet |
| Query shape | the whole dense question | short keywords |
| Behind it | a preset that decomposes, searches in parallel, and (at `low`+) opens pages | one retrieval round trip, no model |
| Use when | you want the ANSWER | you want the LINKS, or you will judge the sources yourself |
| Multiple concepts | fine — one call | split into separate calls |

`ask` is the dominant path. Reach for `find` when you specifically want source
discovery: the raw landing pages for an error string, a list of candidate docs
to hand the user, evidence you intend to read and judge yourself rather than
have summarized.

Because `find` has no decomposition model, concatenating unrelated concepts
into one query returns hits that match none of them well. One concept per
call.

## The core loop

```bash
# 1. Decide (answer or links? what depth?), compose the WHOLE question, run it
#    ONCE, and capture stdout — exit 1 still writes a full envelope there.
agentsearch ask "Does Bun 1.3 implement the Node http2 client API, which \
release added it, and which parts are still unimplemented?" > answer.json

# 2. Read the envelope — success and failure both land in the same place.
jq -r 'if .ok then .data.answer else "\(.error.code): \(.error.message)" end' answer.json

# 3. Judge the evidence before you use the answer.
jq '.data.sources | length' answer.json                    # zero is a red flag
jq -r '.data.sources[] | "\(.ref // "-")  \(.url)"' answer.json
jq '.data.usage | {cost_usd, cost_status, depth, model, tool_calls}' answer.json
```

Narrow that same call with `--recency week` or `--domains bun.sh,github.com`
when the request is time- or source-bound; swap the verb for `agentsearch find
"bun http2 client" --limit 5` when you want the links rather than the
synthesis. Either way it is one call, decided before it is typed.

Step 3 is the step agents skip. An answer with an empty `sources` array is a
model writing from memory — exactly what you came here to avoid.

## Depth: the money decision

`--depth` applies to `ask` only. In ascending cost: `fast`, `low`, `medium`,
`high`.

- **`low` — the default.** It fully answers most questions, including dense
  multi-clause ones. Start here unless the request itself tells you not to.
- **`medium` — the escalation.** Highest facet coverage and the fewest suspect
  claims, at higher latency. Route here **up front** when the request itself
  demands multi-facet coverage: several subquestions, cross-source comparison
  or verification, a root-cause hunt, a broad landscape survey, or explicit
  words like *comprehensive* or *exhaustive*.
- **`fast` — an opt-DOWN for one fact.** A definition, a version number, a
  date. It is not a general cheaper mode: its preset carries no page-fetch leg
  and it silently drops facets on a multi-part question, so the re-run it
  forces makes it the most expensive route per question actually answered.
- **`high` — exhaustive research only.** Rare, slow, explicit, and it
  additionally requires `--allow-expensive`. Reach for it when the user has
  asked for exhaustive work, not on your own initiative.

```bash
agentsearch ask "<whole question>"                          # low, the default
agentsearch ask "<whole question>" --depth medium           # up-front escalation
agentsearch ask "What version of Bun added Bun.YAML?" --depth fast
agentsearch ask "<survey question>" --depth high --allow-expensive
```

**Escalating after a `low` run costs you both calls.** So the up-front
judgement is the one that saves money, and the post-hoc retry needs hard
structural evidence — never a hunch about tone or length. A concise,
single-source answer can be entirely correct. Retry at `medium` only when:

- the answer is empty or declines to answer;
- `data.sources` is empty (or holds nothing usable) under claims that could
  only have come from the web;
- a facet you explicitly named is visibly absent from the answer text.

Anything else — it felt thin, it was shorter than expected, you wanted more
citations — is not evidence. Report what you got.

## Filters

Both verbs accept the same retrieval filters, and both are validated locally
before a paid request is shaped, so a malformed filter costs nothing.

| Flag | Grammar |
|---|---|
| `--recency` | `hour`, `day`, `week`, `month`, or `year` |
| `--domains` | repeatable and comma-splittable; an allowlist (`bun.sh,github.com`) **or** a denylist with every entry `-`-prefixed (`-pinterest.com,-quora.com`); never mixed; 20 entries max |
| `--timeout` | unit required — `500ms`, `30s`, `5m`, `1h30m`. Defaults: 180s for `ask`, 60s for `find` |
| `--limit` | `find` only: 1–20, default 5 |
| `--format` | `json` (default) or `yaml`; `--json` is an alias of `--format json` |

Use `--recency` when the question is about a moving target (a release, an
outage, a price) and stale pages would poison the synthesis. Use `--domains`
when the authoritative source is known — vendor docs, a standards body, one
repository — or to exclude a content farm that keeps outranking the real
source.

## Reading the envelope

Every run prints one `{schema_version, ok, error, data}` value on stdout.

**`ask` → `data = {answer, sources[], usage}`**

- `answer` — the synthesized prose.
- `sources[]` — `{ref, url, title, published_at, updated_at}`. This is the
  **evidence set** the answer was written from, deduped by canonical URL and
  *including pages that were retrieved but never cited*. It is not a
  bibliography of inline references: these presets do not reliably write inline
  markers into the prose, and an answer with no markers is not defective.
- `usage` — `{cost_usd, cost_status, depth, model, input_tokens,
  output_tokens, tool_calls, response_id}`. `tool_calls` counts the legs the
  preset ran, keyed by tool (`search_web`, `fetch_url`).

When a marker *is* present — a `[web:2]`-style ref or a bare `[7]` — it matches
a `sources[].ref` **verbatim, never renumbered**, so an unresolvable reference
is mechanically detectable rather than a judgement call:

```bash
jq -r '
  (.data.answer | [scan("\\[([A-Za-z_]*:?[0-9]+)\\]")] | flatten | unique) as $refs
  | ($refs - (.data.sources | map(.ref) | map(select(. != null))))
  | "unresolved refs: \(.)"' answer.json
```

The CLI records that audit in the ledger; it does not put it in the payload.
Run the check yourself when the answer's citations matter.

**`find` → `data = {hits[], total, usage}`**

- `hits[]` — `{url, title, domain, snippet, last_updated}`, deduped by
  canonical URL, in the provider's ranked order.
- `total` — the number of hits returned after dedupe. It is **not** how many
  pages exist on the web for that query.
- `usage` — `{cost_usd, cost_status, response_id}`.

**There is deliberately no confidence number.** The payload reports depth,
sources, refs, tool counts and status, and refuses to synthesize a score,
because a score would carry authority it has not earned. Judge an answer on its
evidence: are there sources, do they look authoritative, are they recent enough
for the question, do the refs resolve.

## Cost discipline

Cost is usage-based, never a flat per-query figure. Read `data.usage.cost_usd`
and `data.usage.cost_status` on every response.

- `cost_status: "measured"` — `cost_usd` is what the call actually cost.
- `cost_status: "unavailable"` — the provider returned no cost. That is an
  **accounting fault to report**, never a zero to swallow.

Two local budget windows guard spend: a rolling one (default $5 over 24h,
tunable with `AGENTSEARCH_BUDGET_USD` and `AGENTSEARCH_BUDGET_WINDOW_HOURS`)
and a 30-day one (default $50, `AGENTSEARCH_BUDGET_MONTHLY_USD`; the horizon
itself is fixed). Both must admit a call; the first that refuses blocks it with
`error.code: budget_exceeded` before anything is sent. A malformed override
falls back to the default cap rather than to an unlimited one, and `0` is
honored as a kill switch.

**When a call is refused, report it and stop.** Raising a cap is the user's
decision, not a workaround for you to apply.

Before each call the ledger takes a pessimistic *hold* — $0.005 for a `find`,
and $0.02 / $0.15 / $0.50 / $2.00 for an `ask` at `fast` / `low` / `medium` /
`high`. Holds are budget reservations, **not prices**: settlement replaces the
hold with the real cost immediately, and a real cost above the hold is charged
in full. Use them to reason about how many calls fit in a window, never to
quote the user a price.

At 50% and 80% of a window's cap the CLI writes a warning line to stderr. It is
pure telemetry — it never refuses a call — but it is worth surfacing to the
user when you see it. The ledger lives at
`~/.local/state/agentsearch/search/ledger.jsonl` (`AGENTSEARCH_STATE_DIR`
relocates the state root) and records spend only, never the text of your query.

## Failures

An `ok:false` envelope lands on **stdout** with exit 1 and always carries
`error.code`, `error.message`, and `error.recovery`. Branch on the code.

| `error.code` | What happened | Your move |
|---|---|---|
| `missing_api_key` | No key in the environment or the secrets file. Nothing sent, nothing spent. | Tell the user to export `PERPLEXITY_API_KEY` or add it to `~/.config/agentsearch/secrets.json`. Do not loop. |
| `secrets_unreadable` | The secrets file is not valid JSON, or its root is not an object. Nothing sent, nothing spent. | Repair the file's shape. The message never quotes its contents — that would quote the credential. |
| `budget_exceeded` | A window's cap is spent. Nothing sent. `details` names `blocked_window`, `spent_usd`, `cap_usd`, `window_hours`. | Report the numbers and stop. Never raise the cap yourself. |
| `ledger_unavailable` | The ledger could not be read or locked, so the paid request was **skipped** — the ledger fails closed rather than spending unmetered. | Confirm the state directory is writable, then retry. Nothing was spent. |
| `search_failed` | Transport or HTTP failure. `details` carries `attempts`, `latency_ms`, `retry_safe`, plus `http_status` and `provider_message` when the provider answered at all. | Branch on `retry_safe`: `true` (never reached the provider, or a 4xx rejection) → fix and retry; `false` (5xx or ambiguous) → **do not retry**, read the ledger first. |
| `answer_incomplete` | HTTP 200, but the run ended `failed`, `cancelled`, or `incomplete`. This was billed. | `retry_safe` is false. Read `details.status` and `details.cost_usd`. A re-run is a second charge — narrow the question or raise `--timeout` deliberately, or report the failure. |
| `malformed_response` | HTTP 200 with a non-JSON body, a "completed" run carrying no answer text, or a `find` response with no results array. Billed. | `retry_safe` is false. Report it as a provider fault; a partial answer is never emitted as a success. |

Exit codes: **0** the answer or hits were emitted; **1** a transport, provider,
budget, or ledger failure (envelope on stdout); **2** a usage or argument fault
(help on stderr, no envelope, nothing spent).

Two retry rules worth internalizing. Only a clean connect failure and a 429 are
retried automatically, once. And an abort or deadline that fires *after* the
body was sent is classified **ambiguous**, not as a connect failure — the
provider may have served and billed it. That is why raising `--timeout` on a
slow `ask` beats retrying it.

If a call succeeds but its ledger settle fails, the CLI says so on stderr and
the hold stands until it ages out of the window. You still got your answer; the
accounting is conservative on purpose.

## Recipes

**"Look this up" / "what's the latest on X".** The plain path — the whole
question at the default depth. Add `--recency` whenever the subject moves
(a release, an outage, a price) and stale pages would poison the synthesis:

```bash
agentsearch ask "What changed in the Bun 1.3 release series for the Node \
compatibility layer, and which APIs are still missing?"

agentsearch ask "What is the current status of the npm registry incident and \
what is the recommended workaround?" --recency day
```

**"Is that still true?"** Verification is cross-source work by definition, so
route to `medium` up front:

```bash
agentsearch ask "Is it still true that Node's fetch does not support HTTP/2, \
and if it changed, in which release and with what caveats?" --depth medium
```

**A fact the vendor's own docs own.** Constrain the sources — and note that
`fast` earns its place only on a genuinely single fact:

```bash
agentsearch ask "What are the current rate limits and per-token prices for the \
Claude API?" --domains docs.anthropic.com,anthropic.com

agentsearch ask "What is the latest stable Bun version?" --depth fast
```

**Source discovery — you want the links.** Short keywords, one concept per
call, and a denylist when content farms outrank the real source:

```bash
agentsearch find "sqlite wal checkpoint starvation" --limit 8
agentsearch find "bun sqlite wal mode" --limit 5     # separate concept, separate call
agentsearch find "kubernetes pod eviction manager" --domains -pinterest.com,-quora.com
```

**An unfamiliar error string.** `find` the distinctive part of the message —
you want the real page (an issue thread, a changelog), not a paraphrase. Strip
the paths and line numbers that will not recur:

```bash
agentsearch find "ECONNRESET tls socket hang up undici" --limit 5
```

## Anti-patterns

| Don't | Do |
|---|---|
| Split one dense question into three `ask` calls | One `ask` with the whole question — the preset decomposes internally; three calls bill three times |
| Pre-shorten a question to "save money" | Hand it the whole thing; depth is the cost lever, not length |
| Concatenate unrelated concepts into one `find` | One concept per call; split into separate calls |
| Use `--depth fast` as a general cheap mode | `low` is the default that actually answers; `fast` is a single-fact opt-down |
| Escalate to `medium` because the answer felt thin | Escalate on a named missing facet, an empty `sources`, or an empty answer — nothing softer |
| Re-run a failed call reflexively | Read `error.details.retry_safe`; an ambiguous POST may already have billed |
| Raise `AGENTSEARCH_BUDGET_USD` when a call is refused | Report `budget_exceeded` with its numbers and stop; the cap is the user's |
| Treat `cost_status: "unavailable"` as $0 | Report it as an accounting fault |
| Quote a hold as the price of a call | Quote `data.usage.cost_usd` — the hold is a reservation |
| Use `ask` for a URL you already have | The `scrape` skill fetches a specific page |
| Search the web for what this machine knows | The `brain` skill's local index, and the `chats` skill's session history, first |
| Mix allow and deny entries in `--domains` | One list or the other; every deny entry `-`-prefixed |
| Read `data.total` as "how many pages exist" | It is the count of hits returned after dedupe |
| Present an answer with an empty `sources` as researched | Say it came back unsourced, or escalate to `medium` |
| Scrape prose off stderr | stdout is the envelope; stderr is budget warnings and ledger faults |
| Run a call to check the tool works | `--agent-help`, `--help`, `--version` are free; the verbs are not |

## Discovery and drift

The binary self-describes, and every self-description is free:

```bash
agentsearch --agent-help      # the in-binary runbook — the short form of this skill
agentsearch --agent-teaser    # one-line summary
agentsearch --help            # flags, exit codes, auth, cost
agentsearch --version
```

This skill is the deep runbook and `--agent-help` is the in-binary fallback;
both are generated from the same understanding of the CLI, and the CLI is the
authority. After an agentsearch upgrade, re-read `--agent-help` and `--help`
and reconcile anything this document claims that the binary no longer does —
flag names and bounds are interpolated into the help text from the governing
constants, so the binary's numbers are always the enforced ones. The checkout
lives at `~/code/agentsearch`; its `AGENTS.md` records the invariants that must
survive any change.

## Sibling skills

- **`scrape`** — fetching a specific URL's content. `agentsearch` retrieves and
  reasons over search results; it deliberately does not pull a page you name.
  If you already have the link, that is `scrape`'s job, and it does not bill a
  research provider.
- **`brain`** — the local index of what this machine already knows. Check it
  before paying for a web round trip; a hit there is free and instant.
- **`chats`** — every past coding-agent session on this machine. If the
  question is "have we solved this before", that is a search of your own
  history, not of the web.

## For the human

When you hand a web-derived answer back, hand back its evidence too: the
sources you actually leaned on, and the recency window if you set one. If the
user is watching spend, `data.usage.cost_usd` is the real number for the call
you just made — and if `cost_status` came back `unavailable`, say so rather
than reporting a zero. `--format yaml` renders the same envelope in a shape
that reads better over someone's shoulder than pretty-printed JSON.
