/**
 * `~/.config/agentsearch/secrets.json` — the provider-credential file, and the
 * two-step resolution every agentsearch credential reads through.
 *
 * Resolution is env-first, file-second: a non-empty environment variable wins,
 * otherwise the flat JSON object supplies the value. The file leg is what makes
 * a credential work OUTSIDE an interactive shell — a hook-invoked or
 * daemon-invoked process routinely inherits none of a login shell's
 * environment, so an env-only credential would resolve for a human at a
 * terminal and fail everywhere else.
 *
 * Tolerance is deliberate and matches the flat-string schema the file carries:
 * a missing file, a missing key, and an empty or non-string value ALL mean
 * simply "no credential" — never an error. Only a document that is not valid
 * JSON, or one whose root is not an object, is a real fault, because that is a
 * corrupt file rather than an unconfigured one.
 *
 * SECRET HYGIENE: a JSON parser's own error text can quote the offending
 * token, which in this file is a credential. {@link SecretsError} therefore
 * carries a fixed message and NEVER the parser detail or the file's bytes.
 * Nothing in this module logs, echoes, or returns anything but the requested
 * value.
 *
 * The repository's `secrets.schema.json` describes this file for editors; it
 * is generated (`bun run generate:schema`) from the same zod declaration in
 * `src/secrets-schema.ts` that {@link parseSecrets} validates with, so the
 * published documentation and the runtime shape check cannot drift.
 *
 * Lean leaf: `node:os` / `node:path` / `node:fs`, `JSON.parse`, and the zod
 * shape check — a credential read must not open a database or touch the
 * network.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { secretsDocumentSchema } from "./secrets-schema";

/** A corrupt secrets file. The message is fixed and content-free by design. */
export class SecretsError extends Error {}

/**
 * The `~/.config/agentsearch/` base dir. `AGENTSEARCH_CONFIG_DIR` overrides it — the
 * single env seam: the test-isolation lever (os.homedir() ignores $HOME on
 * macOS) and a production override.
 */
export function agentsearchConfigDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.AGENTSEARCH_CONFIG_DIR;
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), ".config", "agentsearch");
}

/** The secrets file (`<config-dir>/secrets.json`). */
export function agentsearchSecretsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(agentsearchConfigDir(env), "secrets.json");
}

/**
 * Parse a secrets document into its flat map. An empty or whitespace-only
 * document is an empty map (an unconfigured file, not a fault); a document that
 * will not parse, or whose root is not an object, throws {@link SecretsError}.
 */
export function parseSecrets(text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message can quote the offending token — i.e. a credential.
    throw new SecretsError("the agentsearch secrets file is not valid JSON");
  }
  if (parsed === null || parsed === undefined) return {};
  if (!secretsDocumentSchema.safeParse(parsed).success) {
    // Only the shape is zod's to judge; its issue list is never rendered, so
    // the fixed message below stays the whole error surface.
    throw new SecretsError(
      "the agentsearch secrets file must be a flat JSON object of name to value",
    );
  }
  // The validated ORIGINAL, not zod's parse output: values must ride through
  // untouched for resolution to judge, and a copy would drop a key JSON.parse
  // defines specially (an own "__proto__" entry stays readable here).
  return parsed as Record<string, unknown>;
}

/** Read and parse the secrets file. An absent file is an empty map. */
export function readSecrets(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Absent, unreadable, or permission-denied all mean "no credentials here".
    return {};
  }
  return parseSecrets(text);
}

export interface SecretDeps {
  readonly env?: Record<string, string | undefined>;
  /** Secrets-file read seam (tests point it at a fixture). */
  readonly readFile?: (path: string) => Record<string, unknown>;
}

/**
 * Resolve one named credential: a non-empty environment variable first, then
 * the same name in the secrets file. Returns `null` when neither supplies a
 * usable value — the caller turns that into its own structured error rather
 * than this module guessing at one.
 */
export function resolveSecret(
  name: string,
  deps: SecretDeps = {},
): string | null {
  const env = deps.env ?? process.env;
  const fromEnv = env[name];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const read = deps.readFile ?? readSecrets;
  const secrets = read(agentsearchSecretsPath(env));
  const fromFile = secrets[name];
  return typeof fromFile === "string" && fromFile.trim().length > 0
    ? fromFile.trim()
    : null;
}
