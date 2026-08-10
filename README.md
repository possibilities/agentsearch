# AgentSearch

[![CI](https://github.com/possibilities/agentsearch/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentsearch/actions/workflows/ci.yml)

Grounded web research for agents: cited answers (`ask`) or ranked links (`find`), live from the Perplexity API, with a spend ledger and budget caps in front of every paid call.

## Install

Requires Bun ≥ 1.3.14 and a `PERPLEXITY_API_KEY` — every call is paid.

```sh
./scripts/install.sh
mkdir -p ~/.config/agentsearch && chmod 700 ~/.config/agentsearch
printf '{"PERPLEXITY_API_KEY": "<key>"}\n' > ~/.config/agentsearch/secrets.json
chmod 600 ~/.config/agentsearch/secrets.json
```

The installer links `$HOME/.local/bin/agentsearch` to this checkout. Set `AGENTSEARCH_INSTALL_BIN_DIR` and `AGENTSEARCH_INSTALL_STATE_DIR` to override the install locations; `./scripts/install.sh --uninstall` removes both. The key also works as a plain environment variable — the file exists for hooks and daemons that inherit no shell profile, and `AGENTSEARCH_CONFIG_DIR` relocates its directory.

The two verbs bill two different Perplexity products — `ask` the Agent API, `find` the Search API — so the key's plan must cover both.

## Use

```sh
agentsearch ask  "<whole dense question>"
agentsearch find "<short keywords>" --limit 5
```

`agentsearch --help` documents flags and exit codes; `agentsearch --agent-help` is the agent runbook (verb routing, depth escalation rules, envelope reading).

## Spending

Cost is usage-based. Read `data.usage.cost_usd` on each response for what a call actually cost. As an anchor, the ledger's pre-authorization holds — pessimistic reservations, not prices — are $0.005 per `find`, and $0.02 / $0.15 / $0.50 / $2.00 per `ask` at depth fast / low / medium / high. See Perplexity's pricing page for current rates.

An append-only ledger at `~/.local/state/agentsearch/search/ledger.jsonl` records every call's cost, and never the query text (`AGENTSEARCH_STATE_DIR` relocates the state root). Two rolling budget windows refuse calls once a cap is spent; tune them with `AGENTSEARCH_BUDGET_USD`, `AGENTSEARCH_BUDGET_WINDOW_HOURS`, and `AGENTSEARCH_BUDGET_MONTHLY_USD`.

## Develop

```sh
bun run check   # biome + tsc + bun test
```
