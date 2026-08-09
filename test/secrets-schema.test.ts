/**
 * `secrets.schema.json` is generated — `bun run generate:schema` — and the
 * drift gate here fails when the checked-in file no longer matches the zod
 * source in `src/secrets-schema.ts`. The invariants below pin what must
 * survive regeneration itself: the map stays open (any credential name
 * resolves), the published types keep documenting the resolution contract,
 * nothing is ever required, and the loader's parse view stays tolerant.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSchema } from "../scripts/generate-schema";
import { secretsDocumentSchema } from "../src/secrets-schema";

type Spec = Record<string, unknown>;

describe("secrets.schema.json", () => {
  test("matches the generator (fix with `bun run generate:schema`)", async () => {
    const checkedIn = JSON.parse(
      await Bun.file(join(import.meta.dir, "..", "secrets.schema.json")).text(),
    );
    expect(checkedIn).toEqual(buildSchema());
  });
});

describe("generated schema invariants", () => {
  test("keeps draft-07 and the verbatim title and description", () => {
    const schema = buildSchema();
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.title).toBe("agentsearch secrets");
    expect(schema.description).toBe(
      "Flat provider-credential map read from ~/.config/agentsearch/secrets.json (AGENTSEARCH_CONFIG_DIR relocates it). Resolution is environment-first: a non-empty environment variable of the same name always wins over this file; the file leg exists so credentials resolve under hooks and daemons that inherit no shell profile. Keep the file chmod 600 — every value is a credential.",
    );
  });

  test("stays an open map of described string credentials", () => {
    // Any credential resolves by exact name: a new provider's key must never
    // require a schema release, so the map can never close.
    const additional = buildSchema().additionalProperties as Spec;
    expect(additional.type).toBe("string");
    expect(additional.description).toBe(
      'Any additional credential, resolved by exact name. An empty or non-string value means "no credential" rather than an error.',
    );
  });

  test("documents $schema and PERPLEXITY_API_KEY as described strings", () => {
    const properties = buildSchema().properties as Record<string, Spec>;
    expect(Object.keys(properties)).toEqual(["$schema", "PERPLEXITY_API_KEY"]);
    for (const spec of Object.values(properties)) {
      expect(spec.type).toBe("string");
      expect(typeof spec.description).toBe("string");
      expect((spec.description as string).length).toBeGreaterThan(0);
    }
  });

  test("requires nothing: an empty or partial file is a valid file", () => {
    expect(buildSchema().required).toBeUndefined();
  });

  test("the loader's parse view judges shape only, never values", () => {
    // Validation placement: the published types above are the resolution
    // contract; at load, any flat object must pass so one wrong-typed entry
    // cannot break every other credential.
    expect(secretsDocumentSchema.safeParse({}).success).toBe(true);
    expect(secretsDocumentSchema.safeParse({ K: "v" }).success).toBe(true);
    expect(secretsDocumentSchema.safeParse({ K: 123 }).success).toBe(true);
    expect(secretsDocumentSchema.safeParse({ K: null }).success).toBe(true);
    expect(secretsDocumentSchema.safeParse(["K"]).success).toBe(false);
    expect(secretsDocumentSchema.safeParse("K").success).toBe(false);
    expect(secretsDocumentSchema.safeParse(42).success).toBe(false);
  });
});
