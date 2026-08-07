/**
 * The shared one-shot JSON envelope for agentsearch CLI commands.
 *
 * Every one-shot read/mutate prints ONE `{schema_version, ok, error, data}`
 * value on stdout. `schema_version` is per-verb — the caller injects it — and
 * versions the `data` payload; the envelope KEY SET itself is governed by an
 * additive-only contract (consumers ignore unknown keys; a field name is never
 * repurposed), so there is no second global envelope version int.
 *
 * Exit model: a transport / provider / budget / ledger failure is an `ok:false`
 * envelope, exit 1 — the envelope still lands on stdout so an agent always
 * parses the last stdout as JSON, never empty stdout + stderr prose. A USAGE /
 * grammar fault (an unknown flag, a bad `--format`, a `--json --format yaml`
 * conflict) is NOT an envelope: it prints help to stderr and exits 2.
 *
 * `error` is `null` on success and `{code, message, recovery}` on failure
 * (RFC 9457 problem-details informs the split):
 *   - `code`     — a stable, machine-matchable problem code.
 *   - `message`  — a corrective one-line human string, not a diagnostic dump; no
 *                  stack traces and no filesystem paths in an agent-facing error.
 *   - `recovery` — the actionable next step, including retry-safety.
 */

/** The failure sub-object every `ok:false` envelope carries. `details` is an
 *  OPTIONAL structured diagnostic (e.g. an ambiguous read's candidate list) —
 *  additive, mirrors the plan family's converged error object; omitted when
 *  there is nothing structured to carry. */
export interface ProblemError {
  code: string;
  message: string;
  recovery: string;
  details?: unknown;
}

/** The one-shot envelope shape. `data` is the payload on success, `null` on
 *  failure; `error` is the inverse. */
export interface Envelope<D> {
  schema_version: number;
  ok: boolean;
  error: ProblemError | null;
  data: D | null;
}

/** Build a success envelope: `ok:true`, `error:null`, the payload in `data`. */
export function successEnvelope<D>(
  schemaVersion: number,
  data: D,
): Envelope<D> {
  return { schema_version: schemaVersion, ok: true, error: null, data };
}

/** Build a failure envelope: `ok:false`, `data:null`, the problem in `error`. */
export function errorEnvelope(
  schemaVersion: number,
  error: ProblemError,
): Envelope<never> {
  return { schema_version: schemaVersion, ok: false, error, data: null };
}

/** The stdout + exit sink an envelope is emitted through. A CLI's real deps
 *  (`process.stdout.write` + `process.exit`) satisfy it, as does a test harness
 *  that captures the string and records the code. */
export interface EnvelopeSink {
  writeStdout: (s: string) => void;
  exit: (code: number) => never;
}
