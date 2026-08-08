// Canonical YAML emitter for `--format yaml` output.
//
// `lineWidth: 0` disables folding, which is load-bearing: a folded URL or answer
// would break a caller that reads the value back out. Insertion order is
// preserved so the envelope's shape stays stable across runs.

import { stringify } from "yaml";

/** Serialize `data` to block-style YAML with no line folding. */
export function yamlDump(data: unknown): string {
  return stringify(data, { lineWidth: 0, sortMapEntries: false });
}
