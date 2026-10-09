/**
 * Requirement coverage -- the honesty rule, in code.
 *
 * A requirement receives a passing state ONLY from a check that actually
 * executed and passed. There is no path in this file by which a requirement
 * without an executed check can be reported as passed: if no bound check ran,
 * the state is UNVERIFIED, and if every bound check failed to execute, the state
 * is ERROR. "Not checked" and "checked and fine" are never the same word.
 */
import { checkIdsByRequirement, collectRequirements } from "./spec.ts";
import type { CheckPack, CheckResult, CheckSpec, CoverageReport, RequirementCoverage } from "./types.ts";

export function selectedChecks(pack: CheckPack, only: string[] | null): CheckSpec[] {
  if (!only || only.length === 0) return pack.checks;
  const wanted = new Set(only);
  const unknown = only.filter((id) => !pack.checks.some((c) => c.id === id));
  if (unknown.length > 0) {
    throw new Error(`--only names check(s) that are not in the pack: ${unknown.join(", ")}`);
  }
  return pack.checks.filter((c) => wanted.has(c.id));
}

export interface CoverageInput {
  pack: CheckPack;
  results: CheckResult[];
  /** Check ids that were selected for this run (so not-selected can be told from not-run). */
  selectedIds: string[];
  /** Requirement ids from an approved requirement set, if one was supplied. */
  requirementIds?: { id: string; text: string | null; source: "pack" | "file" | "pack+file" | "none" }[];
}

export function buildCoverage(input: CoverageInput): CoverageReport {
  const { pack, results } = input;
  const declared = input.requirementIds ?? collectRequirements(pack, null);
  const byRequirement = checkIdsByRequirement(pack);
  const selected = new Set(input.selectedIds);

  // Requirement ids that exist only because a check claims them are still
  // reported -- an id referenced but not declared is worth seeing.
  const ids = new Set<string>(declared.map((d) => d.id));
  for (const id of byRequirement.keys()) ids.add(id);

  const requirements: RequirementCoverage[] = [];
  for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
    const declaredEntry = declared.find((d) => d.id === id);
    const boundChecks = byRequirement.get(id) ?? [];
    const checkIds = boundChecks.map((c) => c.id);
    const executed = results.filter((r) => r.requirement_id === id);
    const passed = executed.filter((r) => r.outcome === "pass").length;
    const failed = executed.filter((r) => r.outcome === "fail").length;
    const errored = executed.filter((r) => r.outcome === "error").length;
    const notSelected = checkIds.filter((c) => !selected.has(c));

    let state: RequirementCoverage["state"];
    let note: string | null = null;
    if (checkIds.length === 0) {
      state = "UNVERIFIED";
      note = "no check in this pack is bound to this requirement";
    } else if (executed.length === 0) {
      state = "UNVERIFIED";
      note = notSelected.length === checkIds.length
        ? `not executed in this run: its check(s) ${notSelected.join(", ")} were filtered out`
        : "its check(s) were selected but produced no result";
    } else if (errored > 0) {
      state = "ERROR";
      note = `${errored} of ${executed.length} executed check(s) could not run to completion`;
    } else if (failed > 0) {
      state = "FAILED";
      note = `${failed} of ${executed.length} executed check(s) failed`;
    } else {
      state = "PASSED";
      note = `${passed} executed check(s) passed`;
    }

    requirements.push({
      id,
      text: declaredEntry?.text ?? null,
      check_ids: checkIds,
      executed: executed.length,
      passed,
      failed,
      errored,
      state,
      note,
    });
  }

  const unverified = requirements.filter((r) => r.state === "UNVERIFIED").map((r) => r.id);
  const totals = {
    requirements: requirements.length,
    passed: requirements.filter((r) => r.state === "PASSED").length,
    failed: requirements.filter((r) => r.state === "FAILED").length,
    errored: requirements.filter((r) => r.state === "ERROR").length,
    unverified: unverified.length,
    checks: {
      total: pack.checks.length,
      selected: input.selectedIds.length,
      executed: results.length,
      passed: results.filter((r) => r.outcome === "pass").length,
      failed: results.filter((r) => r.outcome === "fail").length,
      errored: results.filter((r) => r.outcome === "error").length,
    },
  };

  const honesty: string[] = [];
  honesty.push(
    "A requirement is marked PASSED only where a bound check actually executed and passed. Nothing here is inferred from the absence of a failure.",
  );
  if (unverified.length > 0) {
    honesty.push(
      `${unverified.length} requirement(s) have no executed check and are reported UNVERIFIED, not passed: ${unverified.join(", ")}.`,
    );
  } else {
    honesty.push("Every requirement in this set had at least one bound check that executed.");
  }
  if (totals.errored > 0 || totals.checks.errored > 0) {
    honesty.push(
      `${totals.checks.errored} check(s) could not be executed to completion; the requirement(s) they are bound to are reported ERROR, never PASSED.`,
    );
  }
  honesty.push(
    "Coverage states only what was checked. A requirement that passed is not a claim that the rest of the application works, and an unverified requirement is not a claim that it is broken.",
  );
  if (totals.checks.executed < totals.checks.total) {
    honesty.push(
      `${totals.checks.total - totals.checks.executed} check(s) in the pack were not executed in this run (${totals.checks.selected} of ${totals.checks.total} were selected).`,
    );
  }

  return { requirements, unverified_requirement_ids: unverified, totals, honesty };
}
