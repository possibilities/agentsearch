# agentsearch contributor notes

- Bun ≥ 1.3.14; `bun run check` is the gate for every commit.
- Never run `agentsearch ask`/`find` against the real API while developing —
  every invocation bills. The test suite is hermetic; use it.
- Two request-shaping rules carry real money (`src/perplexity.ts`): a
  filter-free `ask` omits `tools` entirely (an empty or partial array
  overrides the preset's tool bundle — filters ride inside
  `tools[].filters`), and nothing may ever send a top-level `instructions`
  (it supplants the preset's tuned system prompt).
- The ledger fails CLOSED: a reserve fault skips the paid request rather
  than sending it unmetered, and an ambiguous POST is never retried —
  these endpoints carry no idempotency key, so a blind retry can bill
  twice (`src/ledger.ts`, `src/transport.ts`).
- No env var or config may raise the implicit `--depth` above its default;
  a deeper run is always an explicit flag, and `high` also demands
  `--allow-expensive`.
- The flag surface derives from `cli/descriptor.ts`, whose summaries
  interpolate the governing constants — change the constant, never the
  prose.
- `secrets.schema.json` is generated, never hand-edited: the zod surface in
  `src/secrets-schema.ts` is the single source of truth — the loader
  validates with it and `bun run generate:schema` emits the published file
  (a test fails on drift). Placement is deliberate: parse accepts any flat
  JSON object (a wrong-typed value is "no credential" at resolution, never
  an error), while the published types document the resolution contract for
  editors — and the map stays open, so any credential name resolves without
  a schema release.

## The search skill

- `skills/search/SKILL.md` is the canonical deep runbook for this CLI — the
  advertised one. `--agent-help` stays as the in-binary fallback for a session
  that has no skill installed; the two must never contradict each other.
- Funk's skills scanner installs it globally: `npx skills add` against this
  checkout, discovering the nested `skills/<name>/SKILL.md` layout. The skill
  directory ships as a unit, so it stays self-contained — no `../` references
  out of it, and nothing in it may depend on the rest of the repository being
  present.
- A change to CLI behavior obliges re-verifying the skill's claims against the
  live CLI before editing its prose. `--agent-help`, `--help`,
  `--agent-teaser`, and `--version` are free and are the whole verification
  surface; the rule above still holds — never `ask` or `find`.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship globally through Agentdots' scan
  (`~/code/agentdots/scripts/sync-skills`, run six-hourly by Funk's
  updater): a SKILL.md edit is live within six hours, or on demand by
  running that script. Whether a new skill earns a TOOLS.md advertisement
  line is a deliberate decision — `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentdots/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, story, the resource skills — is
  `~/code/agentguidance`; tool-specific runbooks stay here.
