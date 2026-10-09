/**
 * Data model for browser verification.
 *
 * Everything a check needs is DATA, not code: a check pack is JSON, so a
 * non-engineer can author one and so a pack can be versioned, hashed and
 * approved like the rubric. The engine never evaluates JavaScript taken from a
 * spec -- arithmetic in an expectation is evaluated by the small, deterministic
 * expression evaluator in ./expr.ts, over values that were read out of the page.
 * That keeps "same inputs, same verdict" true.
 */

/** Spec version this engine understands. A pack declaring anything else is refused. */
export const CHECK_SPEC_VERSION = 1;

/** Where a read gets its value from. */
export type ReadFrom = "text" | "value" | "attribute" | "count" | "url";
export type ReadAs = "text" | "number" | "integer" | "boolean";

export interface ReadSpec {
  /** A name from the pack's `selectors` map, or a raw CSS selector. */
  selector?: string;
  from?: ReadFrom;
  /** Required when `from` is "attribute". */
  attribute?: string;
  as?: ReadAs;
  /** Regex (source, not slashed) applied to the raw string before parsing. */
  strip?: string;
}

/** A literal, or an arithmetic expression over previously read values. */
export type ValueRef =
  | { value: string | number | boolean }
  | { var: string }
  | { expr: string; vars?: Record<string, ReadSpec> };

export interface ItemSpec {
  /** Optional sub-selector, relative to each item, to read instead of the item's own text. */
  sub_selector?: string;
  attribute?: string;
  as?: "text" | "number";
  strip?: string;
}

export type Predicate =
  | { kind: "text_present"; selector?: string; text: string; mode?: "contains" | "equals"; visible_only?: boolean; message?: string }
  | { kind: "text_absent"; selector?: string; text: string; mode?: "contains" | "equals"; visible_only?: boolean; message?: string }
  | { kind: "element_visible"; selector: string; message?: string }
  | { kind: "element_hidden"; selector: string; message?: string }
  | { kind: "count_equals"; selector: string; expected: ValueRef; message?: string }
  | { kind: "attribute_equals"; selector: string; attribute: string; expected: ValueRef; message?: string }
  | { kind: "value_equals"; actual: ReadSpec; expected: ValueRef; tolerance?: number; message?: string }
  | { kind: "value_in_range"; actual: ReadSpec; min?: ValueRef; max?: ValueRef; tolerance?: number; message?: string }
  | { kind: "cross_page_agrees"; left: ValueRef; right: ValueRef; tolerance?: number; require_different_pages?: boolean; message?: string }
  | {
      kind: "list_order";
      selector: string;
      /** sequence: the items must appear in `expected` order. ascending/descending: numeric order by item. */
      mode: "sequence" | "ascending" | "descending";
      expected?: string[];
      item?: ItemSpec;
      message?: string;
    }
  | { kind: "list_membership"; selector: string; contains?: string[]; not_contains?: string[]; item?: ItemSpec; message?: string }
  | { kind: "url_matches"; pattern: string; mode?: "contains" | "equals"; message?: string };

export type Step =
  | { op: "navigate"; path?: string; url?: string; wait_until?: "load" | "domcontentloaded"; note?: string }
  | { op: "click"; selector: string; note?: string }
  | { op: "type"; selector: string; text: string; clear?: boolean; press_enter?: boolean; note?: string }
  | { op: "wait_for"; selector: string; state?: "visible" | "hidden" | "attached" | "detached"; timeout_ms?: number; note?: string }
  | { op: "wait_for_text"; selector?: string; text: string; mode?: "contains" | "equals"; timeout_ms?: number; note?: string }
  | { op: "read"; name: string; selector?: string; from?: ReadFrom; attribute?: string; as?: ReadAs; strip?: string; note?: string }
  | { op: "read_many"; name: string; selector: string; item?: ItemSpec; note?: string }
  | { op: "expect"; expect: Predicate }
  | { op: "screenshot"; label?: string; full_page?: boolean; note?: string }
  | { op: "note"; text: string };

export interface CheckSpec {
  id: string;
  /** The requirement this check is bound to. A check without one is a spec error. */
  requirement_id: string;
  description: string;
  /** Optional pre-conditions are just steps: the run executes them in order. */
  steps: Step[];
  /** Alternative to an `expect` step: the expected outcome for the whole check. */
  expect?: Predicate;
  timeout_ms?: number;
}

export interface CheckPack {
  spec_version: number;
  pack_id: string;
  pack_version: string;
  description?: string;
  /** Base URL of the application under test; `--base-url` overrides it. */
  base_url?: string;
  app_version?: string;
  /** Named selectors, referenced by name from steps and predicates. */
  selectors?: Record<string, string>;
  requirements?: { id: string; text?: string }[];
  checks: CheckSpec[];
}

export interface RequirementSet {
  set_id?: string;
  version?: string;
  requirements: { id: string; text?: string }[];
}

// ---------------------------------------------------------------------------
// Results and evidence
// ---------------------------------------------------------------------------

export type CheckOutcome = "pass" | "fail" | "error";

/** One executed action. This is what a finding cites when it says "we did this". */
export interface ActionRecord {
  index: number;
  op: string;
  /** The selector as written in the pack (a name, or raw CSS). */
  selector: string | null;
  /** The CSS actually used, after name resolution. */
  resolved_selector: string | null;
  value: string | null;
  url: string | null;
  status: "ok" | "error";
  started_at: string;
  duration_ms: number;
  note: string | null;
  error: string | null;
}

export interface ReadRecord {
  name: string;
  selector: string | null;
  resolved_selector: string | null;
  from: ReadFrom;
  as: ReadAs;
  raw: string | number | boolean | null;
  value: string | number | boolean | null;
  url: string;
  timestamp: string;
}

export interface CheckArtifacts {
  /** Run-relative directory holding this check's evidence. */
  dir: string;
  screenshot: string | null;
  screenshots: string[];
  trace: string | null;
  trace_format: "playwright-zip" | "cdp-session-log" | null;
  trace_events: number;
}

export interface CheckResult {
  check_id: string;
  requirement_id: string;
  description: string;
  outcome: CheckOutcome;
  /** What the engine observed, as rendered evidence. */
  observed: string | null;
  /** What the check required, as rendered evidence. */
  expected: string | null;
  detail: string;
  error: { step_index: number | null; op: string | null; message: string } | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  run_id: string;
  driver: string;
  /** The selectors the check used, name -> CSS, as executed. */
  selectors: Record<string, string>;
  actions: ActionRecord[];
  reads: ReadRecord[];
  artifacts: CheckArtifacts;
  final_url: string | null;
}

export interface RequirementCoverage {
  id: string;
  text: string | null;
  check_ids: string[];
  executed: number;
  passed: number;
  failed: number;
  errored: number;
  state: "PASSED" | "FAILED" | "ERROR" | "UNVERIFIED";
  note: string | null;
}

export interface CoverageReport {
  requirements: RequirementCoverage[];
  unverified_requirement_ids: string[];
  totals: {
    requirements: number;
    passed: number;
    failed: number;
    errored: number;
    unverified: number;
    checks: { total: number; executed: number; selected: number; passed: number; failed: number; errored: number };
  };
  /** Plain statements about what this report does and does not claim. */
  honesty: string[];
}

export interface VerificationRun {
  kind: "verification";
  run_id: string;
  timestamp: string;
  engine_version: string;
  driver: { id: string; label: string; executable: string | null };
  pack: { id: string; version: string; spec_version: number; sha256: string; path: string };
  requirement_set: { id: string | null; version: string | null; sha256: string | null; source: "pack" | "file" | "pack+file" | "none" };
  app: { base_url: string; app_version: string | null };
  /** sha256 over the outcome-bearing fields only: same inputs, same digest. */
  outcome_digest: string;
  checks: CheckResult[];
  coverage: CoverageReport;
  artifacts: {
    run_dir: string;
    run_json: string;
    report_markdown: string;
    coverage_json: string;
  };
  notes: string[];
  prev_hash: string | null;
  hash: string;
}

export interface VerificationSummary {
  seq: number;
  run_id: string;
  timestamp: string;
  pack_id: string;
  pack_version: string;
  base_url: string;
  driver: string;
  checks: { total: number; passed: number; failed: number; errored: number };
  requirements: { total: number; unverified: number };
  outcome_digest: string;
  hash: string;
}
