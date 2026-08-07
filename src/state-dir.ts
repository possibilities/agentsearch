/**
 * `~/.local/state/agentsearch/` — agentsearch's durable per-user STATE root, the sibling of
 * `agentsearchConfigDir()`'s `~/.config/agentsearch/` (src/agent/config.ts). Deliberately
 * NON-XDG: it is distinct from the XDG-honoring
 * `defaultAgentsearchAgentStateDir` / `agentsearch-agent` dir the tmux
 * launcher uses.
 *
 * `AGENTSEARCH_STATE_DIR` overrides it — the single env seam (the test-isolation lever,
 * since os.homedir() ignores $HOME on macOS, and a production override).
 *
 * Dep-free leaf: `node:*` only, never bun:sqlite — the durable panel state under
 * `<state-dir>/panels/` is filesystem-only, so `src/pair/panel.ts` can import this
 * without reaching the DB island.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The `~/.local/state/agentsearch/` base dir (or `AGENTSEARCH_STATE_DIR` when set). */
export function stateDir(): string {
  const override = process.env.AGENTSEARCH_STATE_DIR;
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), ".local", "state", "agentsearch");
}
