/**
 * `~/.local/state/agentsearch/` — the durable per-user STATE root, the sibling
 * of `~/.config/agentsearch/` (src/secrets.ts). The spend ledger lives here.
 *
 * `AGENTSEARCH_STATE_DIR` overrides it — the single env seam (the test-isolation
 * lever, since os.homedir() ignores $HOME on macOS, and a production override).
 *
 * Dep-free leaf: `node:*` only.
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
