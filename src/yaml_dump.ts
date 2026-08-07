// Canonical YAML emitter for `--format yaml` output.
// Block-style mapping output: no key sorting, unicode preserved, dashes at the
// parent indent, and lineWidth -1 to disable folding so a long URL or answer is
// never wrapped mid-token. Carried over from Keeper with its options intact.

import yaml from "js-yaml";

/** Serialize `data` to block-style YAML with PyYAML-matching options. */
export function yamlDump(data: unknown): string {
  return yaml.dump(data, {
    noArrayIndent: true,
    lineWidth: -1,
    sortKeys: false,
  });
}
