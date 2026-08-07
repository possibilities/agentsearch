# Agentsearch

Grounded web research for agents: cited answers and ranked hits, with a spend
ledger in front of every paid call.

Extracted from Keeper, where it was one verb inside an event-sourced daemon.
Nothing here needs a daemon, a database, or a socket — a consumer that wants web
search should not inherit a control plane to get it.

## Verbs

```sh
agentsearch ask  "<question>" [--depth fast|low|medium|high]
agentsearch find "<query>" [--limit <n>]
```

`ask` buys a synthesized, cited answer — the depth preset decomposes one dense
question into parallel retrievals, so hand it the **whole** question rather than
pre-splitting it. `find` buys ranked hits and nothing else: no decomposition
model sits behind it, so its queries are short keywords and unrelated concepts
belong in separate calls.

Both write the `{schema_version, ok, error, data}` envelope on stdout;
`--format yaml` renders the same value as YAML.

## Requirements

| Component | Requirement |
| --- | --- |
| Bun | exactly 1.3.14, matching `package.json` `engines.bun` |
| `PERPLEXITY_API_KEY` | required; every call is paid |

## Configure

The key comes from the environment, or from an owner-only mode-0600 file so it
works under hooks and daemons that inherit no shell profile:

```sh
mkdir -p ~/.config/agentsearch && chmod 700 ~/.config/agentsearch
printf 'PERPLEXITY_API_KEY: <key>\n' > ~/.config/agentsearch/secrets.yaml
chmod 600 ~/.config/agentsearch/secrets.yaml
```

`AGENTSEARCH_CONFIG_DIR` relocates that directory.

## Spending

Every invocation spends real money, which shapes the control flow:

- the depth default is a constant no environment can raise;
- `--depth high` additionally demands `--allow-expensive`;
- a rolling budget hold is taken **before** the request and settled to the real
  cost after;
- an ambiguous POST failure is never retried — these endpoints carry no
  idempotency key, so a blind retry can bill twice.

The ledger is append-only JSONL under `~/.local/state/agentsearch/`
(`AGENTSEARCH_STATE_DIR` relocates it): a `reserve` record written before the
request as a conservative pre-authorization hold, and a `settle` record after it
carrying timestamp, verb, depth, model, status, latency, tokens, tool counts,
exact cost, and response id. **The query text is never recorded.**

Budget limits come from `AGENTSEARCH_BUDGET_USD`,
`AGENTSEARCH_BUDGET_WINDOW_HOURS`, and `AGENTSEARCH_BUDGET_MONTHLY_USD`.

## Development

```sh
bun install
bun run check   # biome + tsc + bun test
```
