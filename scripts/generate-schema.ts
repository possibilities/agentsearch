/**
 * Generates `secrets.schema.json` from the zod schema in
 * `src/secrets-schema.ts` — the same declaration the loader validates with,
 * so the published file cannot drift from what the runtime accepts. The
 * schema is the credential file's documentation, and this generator refuses
 * to emit an undocumented key or a silently closed map.
 *
 * Regenerate with `bun run generate:schema`; `test/secrets-schema.test.ts`
 * fails when the checked-in file drifts from this source.
 */

import { join } from "node:path";
import { z } from "zod";
import { secretsFileSchema } from "../src/secrets-schema";

const TITLE = "agentsearch secrets";
const DESCRIPTION =
  "Flat provider-credential map read from ~/.config/agentsearch/secrets.json (AGENTSEARCH_CONFIG_DIR relocates it). Resolution is environment-first: a non-empty environment variable of the same name always wins over this file; the file leg exists so credentials resolve under hooks and daemons that inherit no shell profile. Keep the file chmod 600 — every value is a credential.";

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema is the credential file's documentation; every key carries it. */
function assertDocumented(schema: Schema): void {
  const props = schema.properties;
  if (!isObject(props)) throw new Error("schema has no properties");
  for (const [key, value] of Object.entries(props)) {
    const description = isObject(value) ? value.description : undefined;
    if (typeof description !== "string" || description.length === 0) {
      throw new Error(`schema property "${key}" has no description`);
    }
  }
}

/**
 * The map must stay OPEN (any credential resolves by exact name) and its
 * additional entries must stay described string types — the resolution
 * contract (only a non-empty string resolves), published for editors while
 * the loader's parse deliberately tolerates any value.
 */
function assertOpenStringMap(schema: Schema): void {
  const additional = schema.additionalProperties;
  if (
    !isObject(additional) ||
    additional.type !== "string" ||
    typeof additional.description !== "string" ||
    additional.description.length === 0
  ) {
    throw new Error(
      "the secrets map is no longer an open, described map of string credentials",
    );
  }
}

/**
 * The "input" io mode is deliberate: the schema describes what a human may
 * write on disk, where every field is omittable. An unconfigured `{}` — or
 * an empty file — is valid, so nothing may ever be `required`.
 */
export function buildSchema(): Schema {
  const generated = z.toJSONSchema(secretsFileSchema, {
    target: "draft-7",
    io: "input",
  }) as Schema;
  const { $schema, ...rest } = generated;
  const schema: Schema = {
    $schema,
    title: TITLE,
    description: DESCRIPTION,
    ...rest,
  };
  if (schema.type !== "object") throw new Error("schema root is not an object");
  if (schema.required !== undefined) {
    throw new Error("no secret may ever be required; an empty file is valid");
  }
  assertDocumented(schema);
  assertOpenStringMap(schema);
  return schema;
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "secrets.schema.json");
  await Bun.write(path, `${JSON.stringify(buildSchema(), null, 2)}\n`);
  console.log(`wrote ${path}`);
}
