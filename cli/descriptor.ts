/**
 * The command descriptor for `agentsearch`, and the derivation helper that turns
 * it into a `node:util` `parseArgs` options object. The descriptor exists so the
 * accepted flags cannot diverge from the documented flags.
 */

/** The two value shapes `node:util` `parseArgs` supports. */
export type FlagType = "boolean" | "string";

/**
 * One CLI flag, described once. The behavior-critical fields (`type`, `short`,
 * `multiple`, `default`) are exactly what {@link buildParseOptions} feeds
 * `parseArgs`, so a derived leaf's parse surface is definitionally this data.
 * `summary` is documentation-only (leaf help / the JSON index).
 */
export interface FlagDescriptor {
  readonly name: string;
  readonly type: FlagType;
  /** Single-character alias (e.g. `h` for `--help`). */
  readonly short?: string;
  /** Repeatable flag → parsed value is an array. */
  readonly multiple?: boolean;
  /** `parseArgs` default (booleans that read as `false` when absent). */
  readonly default?: boolean | string;
  /** One-line human description. */
  readonly summary?: string;
}

/**
 * A `node:util` `parseArgs` option config, reproduced structurally so this module
 * needs no `node:util` import to stay dependency-free. Assignable to
 * `ParseArgsConfig["options"]` values at every call site.
 */
export interface ParseOption {
  type: FlagType;
  short?: string;
  multiple?: boolean;
  default?: boolean | string;
}

/** The output renderings a finite-output read command can produce. Declared
 *  truthfully — a command never advertises a mode it cannot render. */
export type FormatMode = "json" | "yaml";

/**
 * One command (top-level subcommand, or a nested verb under `verbs`). The
 * recursive `verbs` array carries the two-level surface (`ask`, `find`).
 * `flags` is authoritative for a derived leaf.
 */
export interface CommandDescriptor {
  readonly name: string;
  readonly summary: string;
  /** Output renderings this command can produce (finite-output reads only). */
  readonly format_modes?: readonly FormatMode[];
  /** The flag surface (authoritative for derived leaves). */
  readonly flags: readonly FlagDescriptor[];
  /** Nested verbs for a two-level command. */
  readonly verbs?: readonly CommandDescriptor[];
}

// ── derivation helper ────────────────────────────────────────────────────────

/** One flag → its `parseArgs` option config, preserving literal `type` / `short`
 *  / `multiple` / `default` so `parseArgs` can type `values` precisely. */
type ToOption<F extends FlagDescriptor> = { type: F["type"] } & (F extends {
  short: infer S extends string;
}
  ? { short: S }
  : unknown) &
  (F extends { multiple: infer M extends boolean }
    ? { multiple: M }
    : unknown) &
  (F extends { default: infer D extends boolean | string }
    ? { default: D }
    : unknown);

/** A flag tuple → the keyed `parseArgs` options object type. When the flags are
 *  an `as const` literal, this reproduces exactly the type an inline options
 *  literal would have had — so a derived leaf keeps its precise `values` typing. */
type ToOptions<F extends readonly FlagDescriptor[]> = {
  [E in F[number] as E["name"]]: ToOption<E & FlagDescriptor>;
};

/**
 * Build the `node:util` `parseArgs` `options` object from a flag list. The one
 * seam that makes "the descriptor drives the parser": a derived leaf passes
 * `buildParseOptions(FLAGS)` as its `parseArgs({ options })`, so its accepted
 * flags cannot diverge from its documented flags. Only the behavior-critical
 * fields flow through; `summary` is dropped (parseArgs ignores it).
 *
 * Generic over a `const` flag tuple so a leaf passing its `as const` flags gets
 * back a precisely-typed options object — `parseArgs` then types `values` with
 * per-flag precision, identical to the retired inline literal. Called with a
 * widened `FlagDescriptor[]` (via {@link parseOptions}) it degrades gracefully to
 * a loose object, which is all its non-leaf consumers (tests, index) need.
 */
export function buildParseOptions<const F extends readonly FlagDescriptor[]>(
  flags: F,
): ToOptions<F> {
  const options: Record<string, ParseOption> = {};
  for (const f of flags) {
    const opt: ParseOption = { type: f.type };
    if (f.short !== undefined) opt.short = f.short;
    if (f.multiple !== undefined) opt.multiple = f.multiple;
    if (f.default !== undefined) opt.default = f.default;
    options[f.name] = opt;
  }
  return options as ToOptions<F>;
}

const FLAG_HELP = {
  name: "help",
  type: "boolean",
  short: "h",
  summary: "Show this help",
} as const satisfies FlagDescriptor;

/** The shared `--format json|yaml|human` flag for a finite-output JSON reader.
 *  The command's `format_modes` declares which values it actually renders; an
 *  off-list value is a usage fault (see `cli/format.ts`). */
const FLAG_FORMAT = {
  name: "format",
  type: "string",
  summary: "Output format: json|yaml (default json)",
} as const satisfies FlagDescriptor;

/** `--json`, the documented alias of `--format json`, kept beside `--format`
 *  for the readers that shipped it first. */
const FLAG_JSON_ALIAS = {
  name: "json",
  type: "boolean",
  summary: "Alias of --format json",
} as const satisfies FlagDescriptor;

/** The retrieval filters both `search` verbs accept. `--domains` is repeatable
 *  AND comma-splittable; the leaf validates the allowlist-or-denylist rule and
 *  the entry ceiling before a paid request is shaped. */
const SEARCH_FILTER_FLAGS = [
  {
    name: "recency",
    type: "string",
    summary: "Retrieval window: hour|day|week|month|year",
  },
  {
    name: "domains",
    type: "string",
    multiple: true,
    summary:
      "Comma-separated domains; an allowlist, or a denylist with every entry prefixed '-' (max 20)",
  },
  {
    name: "timeout",
    type: "string",
    summary: "Request deadline (shared duration grammar, e.g. 90s, 3m)",
  },
] as const satisfies readonly FlagDescriptor[];

const SEARCH_ASK_FLAGS = [
  FLAG_HELP,
  FLAG_FORMAT,
  FLAG_JSON_ALIAS,
  {
    name: "depth",
    type: "string",
    summary:
      "Research depth: fast|low|medium|high (default low; medium escalates, fast opts down to one fact)",
  },
  {
    name: "allow-expensive",
    type: "boolean",
    default: false,
    summary: "Acknowledge the cost of --depth high (required with it)",
  },
  ...SEARCH_FILTER_FLAGS,
] as const satisfies readonly FlagDescriptor[];

const SEARCH_FIND_FLAGS = [
  FLAG_HELP,
  FLAG_FORMAT,
  FLAG_JSON_ALIAS,
  {
    name: "limit",
    type: "string",
    summary: "Hits to return, 1-20 (default 5)",
  },
  ...SEARCH_FILTER_FLAGS,
] as const satisfies readonly FlagDescriptor[];

const AGENTSEARCH_COMMAND: CommandDescriptor = {
  name: "agentsearch",
  summary:
    "Grounded web research: `agentsearch <ask|find>` (answers vs. ranked hits)",
  format_modes: ["json", "yaml"],
  flags: [FLAG_HELP],
  verbs: [
    {
      name: "ask",
      summary:
        "Synthesized, cited answer to one dense question (hand it the whole question)",
      format_modes: ["json", "yaml"],
      flags: SEARCH_ASK_FLAGS,
    },
    {
      name: "find",
      summary:
        "Ranked web hits for the caller to analyze (short keyword queries)",
      format_modes: ["json", "yaml"],
      flags: SEARCH_FIND_FLAGS,
    },
  ],
};

export const COMMANDS: readonly CommandDescriptor[] = [AGENTSEARCH_COMMAND];

const BY_NAME = new Map<string, CommandDescriptor>(
  COMMANDS.map((command) => [command.name, command] as const),
);

/** The descriptor for a command name, or undefined when it is not ours. */
export function nativeDescriptor(
  command: string,
): CommandDescriptor | undefined {
  return BY_NAME.get(command);
}

/**
 * The `parseArgs` options for a command, or one of its verbs. A caller names the
 * verb it is parsing and gets a clear failure when that verb does not exist.
 */
export function parseOptions(
  command: string,
  verb?: string,
): Record<string, ParseOption> {
  const top = BY_NAME.get(command);
  if (top === undefined)
    throw new Error(`descriptor: unknown command '${command}'`);
  if (verb === undefined) return buildParseOptions(top.flags);
  const nested = top.verbs?.find((entry) => entry.name === verb);
  if (nested === undefined)
    throw new Error(`descriptor: unknown verb '${command} ${verb}'`);
  return buildParseOptions(nested.flags);
}
