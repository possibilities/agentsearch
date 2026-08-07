# agentsearch

Grounded web research for agents: cited answers (`ask`) and ranked hits (`find`) from the Perplexity API, with a spend ledger and budget caps in front of every paid call.

## Install

Requires Bun 1.3.14 and a `PERPLEXITY_API_KEY` — every call is paid.

```sh
bun install
mkdir -p ~/.config/agentsearch && chmod 700 ~/.config/agentsearch
printf 'PERPLEXITY_API_KEY: <key>\n' > ~/.config/agentsearch/secrets.yaml
chmod 600 ~/.config/agentsearch/secrets.yaml
```

The environment variable also works; the file leg exists for hooks and daemons that inherit no shell profile. `AGENTSEARCH_CONFIG_DIR` relocates the directory.

## Use

```sh
agentsearch ask  "<whole dense question>"
agentsearch find "<short keywords>" --limit 5
```

`agentsearch --help` documents flags and exit codes; `agentsearch --agent-help` is the agent runbook (verb routing, depth escalation rules, envelope reading).

## Spending

An append-only ledger under `~/.local/state/agentsearch/` (`AGENTSEARCH_STATE_DIR` relocates it) records every call's cost — never the query text. Two rolling budget windows refuse calls once a cap is spent; tune with `AGENTSEARCH_BUDGET_USD`, `AGENTSEARCH_BUDGET_WINDOW_HOURS`, and `AGENTSEARCH_BUDGET_MONTHLY_USD`.

## Develop

```sh
bun run check   # biome + tsc + bun test
```
