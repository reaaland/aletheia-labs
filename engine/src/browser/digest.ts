/**
 * The outcome digest: a hash over WHAT WAS OBSERVED, and of nothing else.
 *
 * `outcome_digest` is the engine's reproducibility claim made checkable -- same
 * check pack, same application state, same digest. For that claim to mean
 * anything, the digest has to be a function of the observed outcome alone:
 * never of when the run happened, how long it took, where the run wrote its
 * files, or which temporary directory the browser was handed.
 *
 * So the digest projects each check result down to its outcome-bearing fields.
 * Measured durations, wall-clock timestamps, run ids and artifact paths are
 * dropped outright -- not masked, absent. The projection itself is exported
 * (`digestProjection`) so an auditor can print exactly what was hashed instead
 * of taking this comment's word for it.
 *
 * Two classes of volatile text can still reach the digest through the
 * human-readable explanation fields (`detail`, `error.message`, `action.error`),
 * because a driver's message is prose written by somebody else:
 *
 *   1. text that varies run to run -- elapsed times, wall-clock stamps, stack
 *      frames, temporary paths, heap addresses (VOLATILE_TEXT_RULES below);
 *   2. the host and port the application happened to be served on, which is
 *      normalised to `<origin>` so that the same application state on a
 *      different port is not reported as a different outcome.
 *
 * The split is drawn by WHO WROTE THE TEXT, not by what it looks like:
 *
 *   - engine prose (`detail`, `error.message`, `action.error`) is normalised,
 *     because it quotes driver messages, timeouts and paths that this engine
 *     does not author and cannot otherwise pin down;
 *   - page content (`observed`, `expected`, values read out of the page,
 *     action values and URLs) is NOT normalised -- it is the evidence. Moving
 *     an application from one port to another must not change the verdict;
 *     changing a number on a page must.
 *
 * Boundary, stated rather than papered over: because page content is left
 * alone, a check whose observed text differs between two runs -- an app that
 * renders a clock, say -- produces a different digest, and that is the correct
 * answer: the evidence really did differ. The digest refuses to call two
 * different observations the same. What it will not do is let the clock in
 * timestamps, elapsed times, temporary paths, heap addresses and stack frames
 * that the ENGINE itself wrote change the verdict of an otherwise identical
 * run. Both sides of that line are pinned by tests in
 * `tests/determinism.test.ts`.
 */
import { dirname } from "node:path";
import { canonicalJson, hashHex } from "../util/ids.ts";
import type { CheckResult } from "./types.ts";

export interface VolatileTextRule {
  /** Stable id, quoted in the run record's notes and in the README. */
  id: string;
  /** Plain-language statement of what varies and why it must not reach a digest. */
  what: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Every rule that rewrites run-to-run-varying text before it is hashed. Each is
 * deliberately narrow: a token has to have the shape of a measurement, a
 * timestamp, a machine path, a memory address or a stack frame to be rewritten.
 * Order matters -- timestamps are rewritten before bare clock times, and
 * temporary paths before stack frames, so a later rule cannot chew on the
 * replacement of an earlier one.
 */
export const VOLATILE_TEXT_RULES: VolatileTextRule[] = [
  {
    id: "temp-path",
    what: "operating-system temporary directories, which differ on every run",
    pattern: /(?:\/private)?\/(?:tmp|var\/folders)\/[^\s"',;)\]]*|\b[A-Za-z]:\\[^\s"',;)\]]*\\Temp\\[^\s"',;)\]]*/gi,
    replacement: "<temp-path>",
  },
  {
    id: "iso-timestamp",
    what: "ISO-8601 wall-clock timestamps",
    pattern: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    replacement: "<timestamp>",
  },
  {
    id: "date-to-string-timestamp",
    what: "`Date.toString()`-style timestamps, the form Chromium prints",
    pattern: /\b[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: \([^)]*\))?/g,
    replacement: "<timestamp>",
  },
  {
    id: "clock-time",
    what: "a bare wall-clock time",
    pattern: /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g,
    replacement: "<time>",
  },
  {
    id: "duration",
    what: "measured durations, in every unit a driver or Playwright quotes",
    pattern: /(?:\b\d+(?:\.\d+)?(?:ms|s|m|h)\b)|(?:\b\d+(?:\.\d+)?\s+(?:milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?)\b)/gi,
    replacement: "<duration>",
  },
  {
    id: "heap-address",
    what: "heap or object addresses, as printed by an engine crash",
    pattern: /\b0x[0-9a-f]{4,}\b/gi,
    replacement: "<address>",
  },
  {
    id: "stack-frame",
    what: "stack-frame coordinates, source:line:column",
    pattern: /(?:\bat\s+)?[^\s()"']*:\d+:\d+\b/g,
    replacement: "<frame>",
  },
];

/** Rewrite the volatile tokens in one piece of explanatory text. */
export function normalizeVolatileText(text: string | null): string | null {
  if (text === null) return null;
  let out = text;
  for (const rule of VOLATILE_TEXT_RULES) out = out.replace(rule.pattern, rule.replacement);
  return out;
}

/**
 * The scope a run happened in: the origin of the application under test and the
 * directories the run wrote to. These are normalised out of the digest, and
 * recorded verbatim in the run record, where they are evidence rather than
 * identity.
 */
export interface DigestScope {
  /** Base URL of the application under test; its origin becomes `<origin>`. */
  baseUrl?: string | null;
  /** The run's artifact directory; becomes `<artifacts>` / `<run-dir>`. */
  artifactsDir?: string | null;
  runDir?: string | null;
}

/**
 * The scope of a run, taken from its own record -- so that
 * `digestOutcomes(run.checks, digestScopeForRun(run))` reproduces the
 * `outcome_digest` the run recorded. An auditor holding only `run.json` can
 * therefore recompute the digest rather than trust it.
 */
export function digestScopeForRun(run: { app: { base_url: string | null }; artifacts: { run_dir: string } }): DigestScope {
  return {
    baseUrl: run.app.base_url,
    runDir: run.artifacts.run_dir,
    artifactsDir: dirname(run.artifacts.run_dir),
  };
}

/** The origin (scheme://host:port) of a URL, or null when it is not a URL. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function scopeFilter(scope: DigestScope, origin: string | null): (text: string) => string {
  const runDir = scope.runDir ?? null;
  const artifactsDir = scope.artifactsDir ?? null;
  return (text: string): string => {
    let out = text;
    if (origin) out = out.split(origin).join("<origin>");
    if (runDir) out = out.split(runDir).join("<run-dir>");
    if (artifactsDir) out = out.split(artifactsDir).join("<artifacts>");
    return out;
  };
}

/**
 * The exact structure that is hashed, exported so the claim "same inputs, same
 * digest" can be inspected rather than believed. Keys are sorted by
 * canonicalJson at hash time; checks are sorted by id here so that a pack whose
 * checks are listed in a different order still yields the same outcome.
 */
export function digestProjection(results: CheckResult[], scope: DigestScope = {}): unknown[] {
  const origin = scope.baseUrl ? originOf(scope.baseUrl) : null;
  const scoped = scopeFilter(scope, origin);
  /** Explanation text: scoped, then stripped of run-to-run volatile tokens. */
  const prose = (text: string | null): string | null => (text === null ? null : normalizeVolatileText(scoped(text)));
  /** Page-derived text and URLs: scoped, but never rewritten as if it were noise. */
  const verbatim = (text: string | null): string | null => (text === null ? null : scoped(text));

  return results
    .map((r) => ({
      check_id: r.check_id,
      requirement_id: r.requirement_id,
      outcome: r.outcome,
      observed: verbatim(r.observed),
      expected: verbatim(r.expected),
      detail: prose(r.detail),
      error: r.error ? { step_index: r.error.step_index, op: r.error.op, message: prose(r.error.message) } : null,
      actions: r.actions.map((a) => ({
        op: a.op,
        resolved_selector: a.resolved_selector,
        value: verbatim(a.value),
        status: a.status,
        error: prose(a.error),
      })),
      reads: r.reads.map((x) => ({
        name: x.name,
        value: typeof x.value === "string" ? verbatim(x.value) : x.value,
        url: x.url === null ? null : verbatim(x.url),
      })),
    }))
    .sort((a, b) => a.check_id.localeCompare(b.check_id));
}

/**
 * sha256 over the projection above: same inputs, same digest.
 *
 * A digest that changed because the machine was 3ms slower would make
 * reproducibility unprovable, and how long something took is not part of what
 * was verified. The actual timings stay in the run record, where they are
 * evidence rather than identity.
 */
export function digestOutcomes(results: CheckResult[], scope: DigestScope = {}): string {
  return hashHex(canonicalJson(digestProjection(results, scope)));
}
