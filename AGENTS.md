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
