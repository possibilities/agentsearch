/**
 * The `secrets.json` surface as a zod schema — the single source of truth:
 * `src/secrets.ts` validates every parsed document with it at load, and
 * `scripts/generate-schema.ts` emits the checked-in `secrets.schema.json`
 * from it (never hand-edit that file), so a credential name is documented
 * exactly when it is declared and described here.
 *
 * One contract, two views, split by validation PLACEMENT:
 *
 * - {@link secretsDocumentSchema} is what `parseSecrets` enforces at load:
 *   any flat JSON object of name to value. Values are deliberately `unknown`
 *   — an empty or wrong-typed value means "no credential" at resolution,
 *   never a parse fault, so one bad entry cannot break every other
 *   credential in an otherwise healthy file (src/secrets.ts).
 * - {@link secretsFileSchema} is what the published schema shows editors:
 *   the named credentials plus string-typed additional entries — the
 *   resolution contract (only a non-empty string resolves) stated as types,
 *   exactly as the hand-written schema always published it.
 *
 * The map is OPEN by design: any credential resolves by exact name, so
 * neither view may ever reject unknown keys — a new provider's key must
 * never require a schema release.
 */

import { z } from "zod";

/**
 * The load-time shape check: a flat JSON object of name to value. Nothing
 * more — key names and value types are resolution's business.
 */
export const secretsDocumentSchema = z.record(z.string(), z.unknown());

/** The documented surface `secrets.schema.json` is generated from. */
export const secretsFileSchema = z
  .object({
    $schema: z
      .string()
      .describe("Reserved for editor tooling; ignored by agentsearch.")
      .optional(),
    PERPLEXITY_API_KEY: z
      .string()
      .describe(
        "Perplexity API key used by `agentsearch ask` and `agentsearch find`. Every call bills against it.",
      )
      .optional(),
  })
  .catchall(
    z
      .string()
      .describe(
        'Any additional credential, resolved by exact name. An empty or non-string value means "no credential" rather than an error.',
      ),
  );
