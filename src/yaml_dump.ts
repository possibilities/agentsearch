// Canonical YAML emitter for `--format yaml` output.
//
// Uses the `yaml` package rather than js-yaml. Keeper reached for js-yaml's
// `noArrayIndent` to match PyYAML's dash-at-parent-indent, because its bundle
// writer produced byte-pinned files. Nothing here is byte-pinned — this renders
// one envelope for a human or an agent to read — and current `@types/js-yaml`
// no longer declares that option, so keeping it would have meant pinning old
// typings to describe a library that still has the flag. Indented sequences are
// the same document to every parser.
//
// `lineWidth: 0` disables folding, which is load-bearing: a folded URL or answer
// would break a caller that reads the value back out. Insertion order is
// preserved so the envelope's shape stays stable across runs.

import { stringify } from "yaml";

/** Serialize `data` to block-style YAML with no line folding. */
export function yamlDump(data: unknown): string {
  return stringify(data, { lineWidth: 0, sortMapEntries: false });
}
