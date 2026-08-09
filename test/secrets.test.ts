/**
 * `~/.config/agentsearch/secrets.json` resolution.
 *
 * Every case points `AGENTSEARCH_CONFIG_DIR` at a per-test fixture directory, so
 * nothing here reads the real secrets file or the real home directory.
 *
 * The tolerance rules are the point: a missing file, a missing key, and an empty
 * value are all simply "no credential", because an unconfigured file is a normal
 * state and must not surface as an error. Only a corrupt document is a fault —
 * and its message must never quote the file, whose contents are credentials.
 * Stray non-JSON files (a pre-migration secrets.yaml, a backup) are simply
 * never read.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentsearchConfigDir,
  agentsearchSecretsPath,
  parseSecrets,
  readSecrets,
  resolveSecret,
  SecretsError,
} from "../src/secrets";

const KEY = "PERPLEXITY_API_KEY";
const FAKE = "pplx-fixture-value-not-a-real-credential";

/** A fixture config dir, optionally seeded with a secrets file. */
function fixture(contents?: string, filename = "secrets.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "agentsearch-secrets-"));
  if (contents !== undefined) {
    writeFileSync(join(dir, filename), contents, "utf8");
  }
  return dir;
}

describe("agentsearchConfigDir", () => {
  test("AGENTSEARCH_CONFIG_DIR overrides the default", () => {
    expect(agentsearchConfigDir({ AGENTSEARCH_CONFIG_DIR: "/tmp/x" })).toBe(
      "/tmp/x",
    );
  });

  test("an empty override falls back to the default location", () => {
    expect(agentsearchConfigDir({ AGENTSEARCH_CONFIG_DIR: "" })).toContain(
      join(".config", "agentsearch"),
    );
  });

  test("the secrets file sits under the config dir", () => {
    expect(agentsearchSecretsPath({ AGENTSEARCH_CONFIG_DIR: "/tmp/x" })).toBe(
      "/tmp/x/secrets.json",
    );
  });
});

describe("parseSecrets", () => {
  test("reads a flat object", () => {
    expect(parseSecrets(`{"${KEY}": "${FAKE}"}\n`)).toEqual({ [KEY]: FAKE });
  });

  test("an empty document is an unconfigured file, not a fault", () => {
    expect(parseSecrets("")).toEqual({});
    expect(parseSecrets("   \n")).toEqual({});
  });

  test("a null document is an unconfigured file, not a fault", () => {
    expect(parseSecrets("null")).toEqual({});
  });

  test("a malformed document is a fault", () => {
    expect(() => parseSecrets('{"key": [unclosed\n')).toThrow(SecretsError);
  });

  test("a non-object root is a fault", () => {
    expect(() => parseSecrets('["a", "b"]\n')).toThrow(SecretsError);
  });

  test("a parse failure never quotes the file's contents", () => {
    // The offending token IS the credential — echoing the parser's message
    // would leak it into whatever logs the error.
    try {
      parseSecrets(`{"${KEY}": ${FAKE}}\n`);
      throw new Error("expected a SecretsError");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as Error).message).not.toContain(FAKE);
    }
  });
});

describe("readSecrets", () => {
  test("an absent file is an empty map", () => {
    const dir = fixture();
    try {
      expect(readSecrets(join(dir, "secrets.json"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stray secrets.yaml is ignored, not read and not an error", () => {
    const dir = fixture(`${KEY}: ${FAKE}\n`, "secrets.yaml");
    try {
      expect(readSecrets(join(dir, "secrets.json"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSecret", () => {
  test("a non-empty environment variable wins over the file", () => {
    const dir = fixture(`{"${KEY}": "from-file"}\n`);
    try {
      expect(
        resolveSecret(KEY, {
          env: { AGENTSEARCH_CONFIG_DIR: dir, [KEY]: "from-env" },
        }),
      ).toBe("from-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the file supplies the value when the environment does not", () => {
    const dir = fixture(`{"${KEY}": "${FAKE}"}\n`);
    try {
      expect(resolveSecret(KEY, { env: { AGENTSEARCH_CONFIG_DIR: dir } })).toBe(
        FAKE,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty environment value falls through to the file", () => {
    const dir = fixture(`{"${KEY}": "${FAKE}"}\n`);
    try {
      expect(
        resolveSecret(KEY, {
          env: { AGENTSEARCH_CONFIG_DIR: dir, [KEY]: "  " },
        }),
      ).toBe(FAKE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file, a missing key, and an empty value all mean no credential", () => {
    for (const contents of [
      undefined,
      '{"OTHER_KEY": "x"}\n',
      `{"${KEY}": ""}\n`,
      "",
    ]) {
      const dir = fixture(contents);
      try {
        expect(
          resolveSecret(KEY, { env: { AGENTSEARCH_CONFIG_DIR: dir } }),
        ).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("a non-string value is not a credential", () => {
    const dir = fixture(`{"${KEY}": 12345}\n`);
    try {
      expect(
        resolveSecret(KEY, { env: { AGENTSEARCH_CONFIG_DIR: dir } }),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt file throws rather than resolving to nothing", () => {
    const dir = fixture('{"key": [unclosed\n');
    try {
      expect(() =>
        resolveSecret(KEY, { env: { AGENTSEARCH_CONFIG_DIR: dir } }),
      ).toThrow(SecretsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stray secrets.yaml resolves to no credential", () => {
    const dir = fixture(`${KEY}: ${FAKE}\n`, "secrets.yaml");
    try {
      expect(
        resolveSecret(KEY, { env: { AGENTSEARCH_CONFIG_DIR: dir } }),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
