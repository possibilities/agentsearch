/**
 * The `agentsearch` cost ledger and its rolling budget circuit breaker.
 *
 * Every case sandboxes the ledger directory under the per-test tmpdir and drives
 * an injected clock, so nothing here reads the real state root or the wall
 * clock. The load-bearing property under test is the accounting rule for an
 * UNKNOWN outcome: a reservation with no settle — or one settled at an unknown
 * cost — keeps charging its hold, so an ambiguous failure can never book as
 * free.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactRecords,
  DEFAULT_BUDGET_USD,
  DEFAULT_BUDGET_WINDOW_HOURS,
  DEFAULT_MONTHLY_BUDGET_USD,
  type LedgerRecord,
  ledgerPath,
  MONTHLY_WINDOW_HOURS,
  parseLedger,
  readLedger,
  reserveSpend,
  resolveBudget,
  type SettleInput,
  settleSpend,
  windowSpendUsd,
} from "../src/ledger";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "agentsearch-search-ledger-"));
}

const HOUR_MS = 60 * 60 * 1_000;

function reserveRecord(
  id: string,
  atMs: number,
  holdUsd: number,
): LedgerRecord {
  return {
    schema_version: 1,
    kind: "reserve",
    id,
    ts: new Date(atMs).toISOString(),
    verb: "ask",
    depth: "low",
    hold_usd: holdUsd,
  };
}

function settleRecord(
  id: string,
  atMs: number,
  costUsd: number | null,
  released = false,
): LedgerRecord {
  return {
    schema_version: 1,
    kind: "settle",
    id,
    ts: new Date(atMs).toISOString(),
    verb: "ask",
    depth: "fast",
    model: "some/model",
    status: released ? "connect_failed" : "completed",
    attempts: 1,
    latency_ms: 10,
    input_tokens: null,
    output_tokens: null,
    tool_calls: {},
    source_count: 0,
    citation_ref_count: 0,
    unresolved_ref_count: 0,
    cost_usd: costUsd,
    cost_status: costUsd === null ? "unavailable" : "measured",
    response_id: null,
    released,
  };
}

/** A settle input for the store-level cases; per-case fields are overridden. */
function settleInput(overrides: Record<string, unknown> = {}): SettleInput {
  return {
    id: "r1",
    verb: "ask",
    depth: "fast",
    model: "some/model",
    status: "completed",
    attempts: 1,
    latency_ms: 1,
    input_tokens: null,
    output_tokens: null,
    tool_calls: {},
    source_count: 0,
    citation_ref_count: 0,
    unresolved_ref_count: 0,
    cost_usd: 0.001,
    cost_status: "measured",
    response_id: null,
    released: false,
    ...overrides,
  };
}

describe("resolveBudget", () => {
  test("defaults both horizons when unset", () => {
    const budget = resolveBudget({});
    expect(budget.rolling).toEqual({
      name: "rolling",
      capUsd: DEFAULT_BUDGET_USD,
      windowHours: DEFAULT_BUDGET_WINDOW_HOURS,
    });
    expect(budget.monthly).toEqual({
      name: "monthly",
      capUsd: DEFAULT_MONTHLY_BUDGET_USD,
      windowHours: MONTHLY_WINDOW_HOURS,
    });
  });

  test("honors an explicit cap, window, and monthly cap", () => {
    const budget = resolveBudget({
      AGENTSEARCH_BUDGET_USD: "1.25",
      AGENTSEARCH_BUDGET_WINDOW_HOURS: "6",
      AGENTSEARCH_BUDGET_MONTHLY_USD: "20",
    });
    expect(budget.rolling).toMatchObject({ capUsd: 1.25, windowHours: 6 });
    expect(budget.monthly).toMatchObject({ capUsd: 20 });
  });

  test("the monthly horizon is fixed at 30 days regardless of the rolling one", () => {
    const budget = resolveBudget({ AGENTSEARCH_BUDGET_WINDOW_HOURS: "1" });
    expect(budget.monthly.windowHours).toBe(MONTHLY_WINDOW_HOURS);
  });

  test("a zero cap is a legitimate kill switch, not a fallback", () => {
    expect(resolveBudget({ AGENTSEARCH_BUDGET_USD: "0" }).rolling.capUsd).toBe(
      0,
    );
  });

  test("a malformed cap falls back to the default, never to unlimited", () => {
    for (const bad of ["", "nope", "-1", "NaN", "Infinity"]) {
      expect(
        resolveBudget({ AGENTSEARCH_BUDGET_USD: bad }).rolling.capUsd,
      ).toBe(DEFAULT_BUDGET_USD);
      expect(
        resolveBudget({ AGENTSEARCH_BUDGET_MONTHLY_USD: bad }).monthly.capUsd,
      ).toBe(DEFAULT_MONTHLY_BUDGET_USD);
    }
  });
});

describe("windowSpendUsd", () => {
  const now = 1_000 * HOUR_MS;
  const window = 24 * HOUR_MS;

  test("a settled call charges its actual cost, not its hold", () => {
    const records = [
      reserveRecord("a", now - HOUR_MS, 0.05),
      settleRecord("a", now - HOUR_MS, 0.01),
    ];
    expect(windowSpendUsd(records, now, window)).toBeCloseTo(0.01, 10);
  });

  test("an UNSETTLED call keeps charging its hold", () => {
    const records = [reserveRecord("a", now - HOUR_MS, 0.05)];
    expect(windowSpendUsd(records, now, window)).toBeCloseTo(0.05, 10);
  });

  test("a settle with an unknown cost still charges the hold", () => {
    const records = [
      reserveRecord("a", now - HOUR_MS, 0.05),
      settleRecord("a", now - HOUR_MS, null),
    ];
    expect(windowSpendUsd(records, now, window)).toBeCloseTo(0.05, 10);
  });

  test("a released hold charges nothing", () => {
    const records = [
      reserveRecord("a", now - HOUR_MS, 0.05),
      settleRecord("a", now - HOUR_MS, null, true),
    ];
    expect(windowSpendUsd(records, now, window)).toBe(0);
  });

  test("spend outside the window is not counted", () => {
    const records = [
      reserveRecord("old", now - 25 * HOUR_MS, 0.5),
      reserveRecord("new", now - HOUR_MS, 0.05),
    ];
    expect(windowSpendUsd(records, now, window)).toBeCloseTo(0.05, 10);
  });
});

describe("parseLedger", () => {
  test("skips a corrupt line rather than failing the whole guard", () => {
    const good = JSON.stringify(reserveRecord("a", 1_000, 0.05));
    const text = `${good}\nnot json\n{"kind":"bogus"}\n\n${good}\n`;
    expect(parseLedger(text)).toHaveLength(2);
  });
});

describe("compactRecords", () => {
  test("drops aged reservations and the settles that belong to them", () => {
    const now = 200 * 24 * HOUR_MS;
    const oldAt = now - 120 * 24 * HOUR_MS;
    const records = [
      reserveRecord("old", oldAt, 0.05),
      settleRecord("old", oldAt, 0.01),
      reserveRecord("new", now - HOUR_MS, 0.05),
      settleRecord("new", now - HOUR_MS, 0.01),
    ];
    expect(compactRecords(records, now).map((r) => r.id)).toEqual([
      "new",
      "new",
    ]);
  });
});

describe("reserveSpend + settleSpend", () => {
  test("a first call takes a hold and records it", () => {
    const dir = sandbox();
    try {
      const now = 1_000 * HOUR_MS;
      const held = reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => now, newId: () => "r1", env: {} },
      );
      expect(held.ok).toBe(true);
      const records = readLedger(ledgerPath(dir));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        kind: "reserve",
        id: "r1",
        verb: "ask",
        depth: "low",
        hold_usd: 0.05,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the ledger never records the query text", () => {
    const dir = sandbox();
    try {
      const now = 1_000 * HOUR_MS;
      const env = {};
      reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => now, newId: () => "r1", env },
      );
      settleSpend(
        settleInput({
          latency_ms: 42,
          input_tokens: 10,
          output_tokens: 20,
          tool_calls: { search_web: 2 },
          source_count: 3,
          citation_ref_count: 1,
          unresolved_ref_count: 0,
          cost_usd: 0.009,
          response_id: "resp_1",
        }),
        { dir, now: () => now, env },
      );
      const text = readFileSync(ledgerPath(dir), "utf8");
      const settle = readLedger(ledgerPath(dir))[1];
      expect(settle).toMatchObject({
        kind: "settle",
        status: "completed",
        model: "some/model",
        latency_ms: 42,
        tool_calls: { search_web: 2 },
        cost_usd: 0.009,
        response_id: "resp_1",
      });
      for (const key of ["query", "input", "question", "prompt"]) {
        expect(text).not.toContain(`"${key}"`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses once the window cap is reached, writing nothing", () => {
    const dir = sandbox();
    try {
      const now = 1_000 * HOUR_MS;
      const env = { AGENTSEARCH_BUDGET_USD: "0.06" };
      const first = reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => now, newId: () => "r1", env },
      );
      expect(first.ok).toBe(true);
      const second = reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => now, newId: () => "r2", env },
      );
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.blocked.name).toBe("rolling");
      expect(second.blocked.capUsd).toBe(0.06);
      expect(second.blocked.spentUsd).toBeCloseTo(0.05, 10);
      // A refusal takes no hold, so it leaves the ledger untouched.
      expect(readLedger(ledgerPath(dir))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a zero cap refuses every call", () => {
    const dir = sandbox();
    try {
      const held = reserveSpend(
        { verb: "find", depth: null, holdUsd: 0.005 },
        {
          dir,
          now: () => 0,
          newId: () => "r1",
          env: { AGENTSEARCH_BUDGET_USD: "0" },
        },
      );
      expect(held.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("settling under cost frees headroom the hold had taken", () => {
    const dir = sandbox();
    try {
      const now = 1_000 * HOUR_MS;
      const env = { AGENTSEARCH_BUDGET_USD: "0.06" };
      reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => now, newId: () => "r1", env },
      );
      settleSpend(settleInput({ cost_usd: 0.001 }), {
        dir,
        now: () => now,
        env,
      });
      const second = reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => now, newId: () => "r2", env },
      );
      expect(second.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unsettled hold keeps blocking, so an ambiguous failure cannot go unmetered", () => {
    const dir = sandbox();
    try {
      const now = 1_000 * HOUR_MS;
      const env = { AGENTSEARCH_BUDGET_USD: "0.06" };
      reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => now, newId: () => "r1", env },
      );
      // No settle at all — the call's outcome is unknown.
      const second = reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => now, newId: () => "r2", env },
      );
      expect(second.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hold ages out of the rolling window", () => {
    const dir = sandbox();
    try {
      const start = 1_000 * HOUR_MS;
      const env = {
        AGENTSEARCH_BUDGET_USD: "0.06",
        AGENTSEARCH_BUDGET_WINDOW_HOURS: "1",
      };
      reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => start, newId: () => "r1", env },
      );
      const later = reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => start + 2 * HOUR_MS, newId: () => "r2", env },
      );
      expect(later.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt ledger line does not disable the guard", () => {
    const dir = sandbox();
    try {
      const now = 1_000 * HOUR_MS;
      const env = { AGENTSEARCH_BUDGET_USD: "0.06" };
      writeFileSync(
        ledgerPath(dir),
        `garbage\n${JSON.stringify(reserveRecord("r0", now, 0.05))}\n`,
        "utf8",
      );
      const held = reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => now, newId: () => "r1", env },
      );
      expect(held.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the monthly horizon refuses a call the rolling one would admit", () => {
    const dir = sandbox();
    try {
      const start = 1_000 * 24 * HOUR_MS;
      const env = {
        AGENTSEARCH_BUDGET_USD: "5",
        AGENTSEARCH_BUDGET_MONTHLY_USD: "0.10",
      };
      // Spend aged out of the 24h window but still inside the 30-day one.
      reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.09 },
        { dir, now: () => start, newId: () => "old", env },
      );
      const later = reserveSpend(
        { verb: "ask", depth: "low", holdUsd: 0.05 },
        { dir, now: () => start + 10 * 24 * HOUR_MS, newId: () => "new", env },
      );
      expect(later.ok).toBe(false);
      if (later.ok) return;
      expect(later.blocked.name).toBe("monthly");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cost that EXCEEDS its reservation is charged in full and blocks the next call", () => {
    const dir = sandbox();
    try {
      const now = 1_000 * HOUR_MS;
      const env = { AGENTSEARCH_BUDGET_USD: "0.20" };
      reserveSpend(
        { verb: "ask", depth: "fast", holdUsd: 0.02 },
        { dir, now: () => now, newId: () => "r1", env },
      );
      // The reservation is an accounting hold, not a cap the API enforces.
      settleSpend(settleInput({ cost_usd: 0.19 }), {
        dir,
        now: () => now,
        env,
      });
      expect(windowSpendUsd(readLedger(ledgerPath(dir)), now, 24 * HOUR_MS)) //
        .toBeCloseTo(0.19, 10);
      const next = reserveSpend(
        { verb: "ask", depth: "fast", holdUsd: 0.02 },
        { dir, now: () => now, newId: () => "r2", env },
      );
      expect(next.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent in-flight holds are counted alongside settled spend", () => {
    const dir = sandbox();
    try {
      const now = 1_000 * HOUR_MS;
      const env = { AGENTSEARCH_BUDGET_USD: "0.10" };
      // Two callers hold; neither has settled. The third must see both.
      for (const id of ["a", "b"]) {
        const held = reserveSpend(
          { verb: "ask", depth: "fast", holdUsd: 0.04 },
          { dir, now: () => now, newId: () => id, env },
        );
        expect(held.ok).toBe(true);
      }
      const third = reserveSpend(
        { verb: "ask", depth: "fast", holdUsd: 0.04 },
        { dir, now: () => now, newId: () => "c", env },
      );
      expect(third.ok).toBe(false);
      if (third.ok) return;
      expect(third.blocked.spentUsd).toBeCloseTo(0.08, 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("warn thresholds report the crossed fraction without refusing", () => {
    const dir = sandbox();
    try {
      const now = 1_000 * HOUR_MS;
      const env = { AGENTSEARCH_BUDGET_USD: "1" };
      const quiet = reserveSpend(
        { verb: "ask", depth: "fast", holdUsd: 0.1 },
        { dir, now: () => now, newId: () => "a", env },
      );
      expect(quiet.ok).toBe(true);
      if (!quiet.ok) return;
      expect(
        quiet.windows.find((w) => w.name === "rolling")?.warnFraction,
      ).toBeNull();

      const loud = reserveSpend(
        { verb: "ask", depth: "high", holdUsd: 0.75 },
        { dir, now: () => now, newId: () => "b", env },
      );
      // Crossing a threshold is telemetry only — the call is still admitted.
      expect(loud.ok).toBe(true);
      if (!loud.ok) return;
      expect(loud.windows.find((w) => w.name === "rolling")?.warnFraction).toBe(
        0.8,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
