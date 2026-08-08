import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLock } from "../src/file-lock";

// flock(2) locks the open-file-description, so two opens of the same path
// contend even inside one process — which makes contention testable without a
// child process.
describe("FileLock", () => {
  test("a held lock refuses a non-blocking acquire; release frees it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentsearch-lock-"));
    const path = join(dir, "ledger.jsonl.lock");

    const held = FileLock.acquire(path);
    expect(FileLock.tryAcquire(path)).toBeNull();

    held.release();
    const second = FileLock.tryAcquire(path);
    expect(second).not.toBeNull();
    second?.release();
  });

  test("release is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentsearch-lock-"));
    const lock = FileLock.acquire(join(dir, "ledger.jsonl.lock"));
    lock.release();
    lock.release();
  });
});
