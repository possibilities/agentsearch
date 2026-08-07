/**
 * The durable local cost ledger and rolling budget circuit breaker for
 * `agentsearch`.
 *
 * Every paid call writes an append-only JSONL pair under
 * `~/.local/state/agentsearch/` (`AGENTSEARCH_STATE_DIR` relocates it): a `reserve`
 * record written BEFORE the request as a conservative pre-authorization hold,
 * and a `settle` record written after it carrying the call's real outcome —
 * timestamp, verb, requested depth, resolved model, status, latency, tokens,
 * tool counts, exact cost, and response id. The QUERY TEXT is never recorded:
 * the ledger is an accounting artifact, not a search history.
 *
 * Reserve-then-settle exists because the cost of a call is unknown until it
 * answers. Spend inside the rolling window is therefore computed as: a settled
 * call charges its actual cost; a released call (the request provably never
 * reached the provider) charges nothing; and an unsettled or unknown-cost call
 * charges its HOLD. That last rule is the load-bearing one — a call that timed
 * out after the request was accepted keeps charging its hold rather than
 * silently booking as free, so an ambiguous failure can never open an unmetered
 * spend hole.
 *
 * Concurrency: every read-modify-write cycle runs under a `flock` on a sidecar
 * lock file, so two sessions racing the same window cannot both pass a check the
 * combined spend would fail.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FileLock } from "./file-lock";
import type { CostStatus, SearchDepth } from "./perplexity";
import { stateDir } from "./state-dir";

export const SEARCH_LEDGER_SCHEMA_VERSION = 1;

/** Default rolling cap, in USD, over {@link DEFAULT_BUDGET_WINDOW_HOURS}. Set
 *  around an order of magnitude above expected daily spend: loose enough not to
 *  trip a legitimate research burst, tight enough to stop a runaway loop. */
export const DEFAULT_BUDGET_USD = 5;

/** Default rolling window, in hours. */
export const DEFAULT_BUDGET_WINDOW_HOURS = 24;

/** Default 30-day cap, in USD. The longer horizon catches a slow bleed that
 *  never trips the daily cap. */
export const DEFAULT_MONTHLY_BUDGET_USD = 50;

/** The long-horizon window, in hours. Fixed at 30 days; only its cap is
 *  tunable, so the two caps can never be configured into disagreeing horizons. */
export const MONTHLY_WINDOW_HOURS = 30 * 24;

/** Fractions of a cap at which a call warns. Warning is pure telemetry: it
 *  never mutates a cap, never refuses a call, and never escalates. */
export const WARN_THRESHOLDS = [0.5, 0.8] as const;

/** Ledger size above which a settle also compacts. */
export const LEDGER_COMPACT_BYTES = 1024 * 1024;

/** Records older than this are dropped by compaction. Comfortably longer than
 *  the longest budget window, so compaction can never erase live spend. */
export const LEDGER_RETENTION_DAYS = 90;

/**
 * The pre-authorization hold per depth — an ACCOUNTING RESERVATION, not a cap
 * on what a call may cost. The API exposes no max-dollar parameter, so nothing
 * here can bound a single call's price; the hold only reserves budget headroom
 * against concurrent callers, and settlement releases the excess immediately.
 * Deliberately pessimistic for the deeper presets, where the cost tail is
 * unsampled: over-reserving only constrains concurrency near the cap, which is
 * the safe direction. A settled call replaces its hold with the reported cost —
 * including a cost that EXCEEDS the hold, which is charged in full.
 */
export const DEPTH_HOLD_USD: Readonly<Record<SearchDepth, number>> = {
  fast: 0.02,
  low: 0.15,
  medium: 0.5,
  high: 2.0,
};

/** The hold for one `find` call — a flat-rate endpoint, so the hold is also the
 *  settled charge whenever the response carries no usage of its own. */
export const FIND_HOLD_USD = 0.005;

export type SearchVerb = "ask" | "find";

export interface ReserveRecord {
  readonly schema_version: number;
  readonly kind: "reserve";
  readonly id: string;
  readonly ts: string;
  readonly verb: SearchVerb;
  readonly depth: SearchDepth | null;
  readonly hold_usd: number;
}

export interface SettleRecord {
  readonly schema_version: number;
  readonly kind: "settle";
  readonly id: string;
  readonly ts: string;
  readonly verb: SearchVerb;
  /** The preset the caller REQUESTED. Kept alongside `model` because a preset
   *  selects its model dynamically — neither one implies the other. */
  readonly depth: SearchDepth | null;
  /** The model the preset actually resolved to. */
  readonly model: string | null;
  readonly status: string;
  /** Transport attempts, including the first — a retry count of 1 means none. */
  readonly attempts: number;
  readonly latency_ms: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly tool_calls: Record<string, number>;
  /** Emitted sources, and how the answer's inline markers resolved against
   *  them. `unresolved_ref_count` above zero means the answer cited evidence
   *  the payload does not carry. */
  readonly source_count: number;
  readonly citation_ref_count: number;
  readonly unresolved_ref_count: number;
  readonly cost_usd: number | null;
  readonly cost_status: CostStatus;
  readonly response_id: string | null;
  /** True ONLY when the request provably never reached the provider, so the
   *  hold is dropped instead of charged. */
  readonly released: boolean;
}

export type LedgerRecord = ReserveRecord | SettleRecord;

export interface LedgerDeps {
  /** State directory override (tests sandbox it; production derives it). */
  readonly dir?: string;
  /** Unix-ms clock. */
  readonly now?: () => number;
  /** Fresh reservation id. */
  readonly newId?: () => string;
  /** Environment for budget resolution. */
  readonly env?: Record<string, string | undefined>;
}

/** `<agentsearch state dir>/search`. */
export function searchStateDir(): string {
  return join(stateDir(), "search");
}

export function ledgerPath(dir: string): string {
  return join(dir, "ledger.jsonl");
}

export function ledgerLockPath(dir: string): string {
  return join(dir, "ledger.jsonl.lock");
}

/** One spend horizon: a cap over a window. */
export interface BudgetWindow {
  readonly name: "rolling" | "monthly";
  readonly capUsd: number;
  readonly windowHours: number;
}

/** Both horizons a call must satisfy. There is deliberately no PER-DEPTH cap:
 *  dollars are fungible, and per-depth caps permit combined overspend while
 *  being harder to reason about. Depth is governed by its reservation and by
 *  the explicit acknowledgement a guarded depth requires. */
export interface Budget {
  readonly rolling: BudgetWindow;
  readonly monthly: BudgetWindow;
}

/** Read one non-negative finite override, else the default. A malformed value
 *  falls back to the DEFAULT cap rather than to an unlimited one: a typo must
 *  never widen a spend guard. `0` is honored — a legitimate kill switch. */
function resolveNumber(
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

/** Resolve both spend horizons from the environment. */
export function resolveBudget(
  env: Record<string, string | undefined> = process.env,
): Budget {
  return {
    rolling: {
      name: "rolling",
      capUsd: resolveNumber(env.AGENTSEARCH_BUDGET_USD, DEFAULT_BUDGET_USD, 0),
      windowHours: Math.max(
        resolveNumber(
          env.AGENTSEARCH_BUDGET_WINDOW_HOURS,
          DEFAULT_BUDGET_WINDOW_HOURS,
          Number.MIN_VALUE,
        ),
        Number.MIN_VALUE,
      ),
    },
    monthly: {
      name: "monthly",
      capUsd: resolveNumber(
        env.AGENTSEARCH_BUDGET_MONTHLY_USD,
        DEFAULT_MONTHLY_BUDGET_USD,
        0,
      ),
      windowHours: MONTHLY_WINDOW_HOURS,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the ledger, skipping any line that will not parse into a known record
 *  shape. A corrupt line is dropped rather than thrown on: the budget guard must
 *  keep working on a partially damaged file. */
export function parseLedger(text: string): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.kind !== "reserve" && parsed.kind !== "settle") continue;
    if (typeof parsed.id !== "string" || typeof parsed.ts !== "string")
      continue;
    records.push(parsed as unknown as LedgerRecord);
  }
  return records;
}

export function readLedger(path: string): LedgerRecord[] {
  if (!existsSync(path)) return [];
  return parseLedger(readFileSync(path, "utf8"));
}

/**
 * Spend inside the rolling window, charging each reservation opened in the
 * window by its settled cost, its hold when unsettled or settled at an unknown
 * cost, or nothing when its settle released it.
 */
export function windowSpendUsd(
  records: readonly LedgerRecord[],
  nowMs: number,
  windowMs: number,
): number {
  const settled = new Map<string, SettleRecord>();
  for (const record of records) {
    if (record.kind === "settle") settled.set(record.id, record);
  }
  const floor = nowMs - windowMs;
  let total = 0;
  for (const record of records) {
    if (record.kind !== "reserve") continue;
    const at = Date.parse(record.ts);
    if (!Number.isFinite(at) || at < floor) continue;
    const settle = settled.get(record.id);
    if (settle === undefined) {
      total += record.hold_usd;
      continue;
    }
    if (settle.released) continue;
    total += settle.cost_usd ?? record.hold_usd;
  }
  return total;
}

/** Drop records whose reservation aged past the retention horizon, keeping every
 *  settle whose reserve survives. */
export function compactRecords(
  records: readonly LedgerRecord[],
  nowMs: number,
): LedgerRecord[] {
  const floor = nowMs - LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  const keep = new Set<string>();
  for (const record of records) {
    if (record.kind !== "reserve") continue;
    const at = Date.parse(record.ts);
    if (!Number.isFinite(at) || at >= floor) keep.add(record.id);
  }
  return records.filter((record) => keep.has(record.id));
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function appendRecord(path: string, record: LedgerRecord): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function compactIfLarge(path: string, nowMs: number): void {
  if (!existsSync(path)) return;
  if (statSync(path).size <= LEDGER_COMPACT_BYTES) return;
  const kept = compactRecords(readLedger(path), nowMs);
  const temp = `${path}.compact`;
  writeFileSync(
    temp,
    kept.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  renameSync(temp, path);
}

/** One horizon's state at reserve time. */
export interface WindowState {
  readonly name: BudgetWindow["name"];
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly windowHours: number;
  /** The highest crossed warn threshold, or null below the lowest. */
  readonly warnFraction: number | null;
}

export type ReserveOutcome =
  | {
      readonly ok: true;
      readonly id: string;
      readonly holdUsd: number;
      readonly windows: readonly WindowState[];
    }
  | {
      readonly ok: false;
      readonly holdUsd: number;
      /** The horizon that refused. */
      readonly blocked: WindowState;
      readonly windows: readonly WindowState[];
    };

/** The highest warn threshold the projected spend crosses, or null. */
function warnFraction(projectedUsd: number, capUsd: number): number | null {
  if (capUsd <= 0) return null;
  const ratio = projectedUsd / capUsd;
  let crossed: number | null = null;
  for (const threshold of WARN_THRESHOLDS) {
    if (ratio >= threshold) crossed = threshold;
  }
  return crossed;
}

/**
 * Take a budget hold for one call, atomically against every concurrent session.
 * The whole check-then-append cycle runs under the ledger lock, so two sessions
 * that would jointly breach a cap cannot both observe headroom — in-flight
 * reservations are counted by the same pass that counts settled spend.
 *
 * BOTH horizons must admit the call; the first that refuses blocks it. Refusal
 * writes NOTHING: a refused call took no hold to release.
 *
 * Throws on a filesystem or lock failure — the caller must treat that as fail
 * CLOSED and skip the paid request, never as implicit headroom.
 */
export function reserveSpend(
  input: {
    readonly verb: SearchVerb;
    readonly depth: SearchDepth | null;
    readonly holdUsd: number;
  },
  deps: LedgerDeps = {},
): ReserveOutcome {
  const dir = deps.dir ?? searchStateDir();
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const budget = resolveBudget(deps.env ?? process.env);
  const nowMs = now();

  ensureDir(dir);
  const lock = FileLock.acquire(ledgerLockPath(dir));
  try {
    const path = ledgerPath(dir);
    const records = readLedger(path);
    const windows: WindowState[] = [budget.rolling, budget.monthly].map(
      (horizon) => {
        const spentUsd = windowSpendUsd(
          records,
          nowMs,
          horizon.windowHours * 60 * 60 * 1_000,
        );
        return {
          name: horizon.name,
          spentUsd,
          capUsd: horizon.capUsd,
          windowHours: horizon.windowHours,
          warnFraction: warnFraction(spentUsd + input.holdUsd, horizon.capUsd),
        };
      },
    );
    const blocked = windows.find(
      (window) => window.spentUsd + input.holdUsd > window.capUsd,
    );
    if (blocked !== undefined) {
      return { ok: false, holdUsd: input.holdUsd, blocked, windows };
    }
    const id = newId();
    appendRecord(path, {
      schema_version: SEARCH_LEDGER_SCHEMA_VERSION,
      kind: "reserve",
      id,
      ts: new Date(nowMs).toISOString(),
      verb: input.verb,
      depth: input.depth,
      hold_usd: input.holdUsd,
    });
    return { ok: true, id, holdUsd: input.holdUsd, windows };
  } finally {
    lock.release();
  }
}

export type SettleInput = Omit<SettleRecord, "schema_version" | "kind" | "ts">;

/** Close out a reservation with the call's real outcome. Appends under the same
 *  lock as {@link reserveSpend}, then compacts an oversized ledger. */
export function settleSpend(input: SettleInput, deps: LedgerDeps = {}): void {
  const dir = deps.dir ?? searchStateDir();
  const now = deps.now ?? Date.now;
  const nowMs = now();
  ensureDir(dir);
  const lock = FileLock.acquire(ledgerLockPath(dir));
  try {
    const path = ledgerPath(dir);
    appendRecord(path, {
      schema_version: SEARCH_LEDGER_SCHEMA_VERSION,
      kind: "settle",
      ts: new Date(nowMs).toISOString(),
      ...input,
    });
    compactIfLarge(path, nowMs);
  } finally {
    lock.release();
  }
}
