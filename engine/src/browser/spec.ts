/**
 * Loading and validation of check packs.
 *
 * A pack is data: JSON, versioned, hashable. This file is the only place that
 * decides whether a pack is well formed, and it refuses a malformed one instead
 * of guessing. Two rules matter most:
 *
 *  - every check must name the requirement id it is bound to;
 *  - every selector a check uses must be declared in the pack's `selectors`
 *    map, or be recognisably CSS. A bare word that looks like a name but is not
 *    declared is a typo, and a typo silently verifying nothing is exactly the
 *    failure mode this system exists to prevent.
 */
import { checkExpression } from "./expr.ts";
import { CHECK_SPEC_VERSION, type CheckPack, type CheckSpec, type Predicate, type RequirementSet, type Step, type ValueRef } from "./types.ts";

export class SpecError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`the check pack is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "SpecError";
    this.problems = problems;
  }
}

const CSS_HINT = /[#.[*>~:+]|\s]/;
const STEP_OPS = ["navigate", "click", "type", "wait_for", "wait_for_text", "read", "read_many", "expect", "screenshot", "note"] as const;
const PREDICATE_KINDS = [
  "text_present",
  "text_absent",
  "element_visible",
  "element_hidden",
  "count_equals",
  "attribute_equals",
  "value_equals",
  "value_in_range",
  "cross_page_agrees",
  "list_order",
  "list_membership",
  "url_matches",
] as const;

function looksLikeCss(ref: string): boolean {
  return CSS_HINT.test(ref);
}

/** Resolve a selector reference (declared name, or inline CSS) to CSS. */
export function resolveSelector(pack: CheckPack, ref: string, problems: string[], where: string): string {
  const declared = pack.selectors?.[ref];
  if (declared) return declared;
  if (looksLikeCss(ref)) return ref;
  problems.push(`${where}: selector "${ref}" is not in the pack's selectors map and does not look like CSS (a typo here would silently check nothing)`);
  return ref;
}

function validateValueRef(ref: unknown, problems: string[], where: string): void {
  if (ref === null || typeof ref !== "object") {
    problems.push(`${where}: expected {value}, {var} or {expr}`);
    return;
  }
  const r = ref as ValueRef;
  if ("value" in r) {
    const v = (r as { value: unknown }).value;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") problems.push(`${where}: value must be a string, number or boolean`);
    return;
  }
  if ("var" in r) {
    if (typeof (r as { var: unknown }).var !== "string") problems.push(`${where}: var must be a string`);
    return;
  }
  if ("expr" in r) {
    const expr = (r as { expr: unknown }).expr;
    if (typeof expr !== "string" || expr.trim() === "") {
      problems.push(`${where}: expr must be a non-empty string`);
      return;
    }
    const err = checkExpression(expr);
    if (err) problems.push(`${where}: expression ${JSON.stringify(expr)} is invalid (${err})`);
    const vars = (r as { vars?: unknown }).vars;
    if (vars !== undefined) {
      if (vars === null || typeof vars !== "object") problems.push(`${where}: vars must be an object of read specs`);
      else {
        for (const [name, spec] of Object.entries(vars as Record<string, unknown>)) {
          validateReadSpec(spec, problems, `${where}.vars.${name}`);
        }
      }
    }
    return;
  }
  problems.push(`${where}: expected {value}, {var} or {expr}`);
}

function validateReadSpec(spec: unknown, problems: string[], where: string): void {
  if (spec === null || typeof spec !== "object") {
    problems.push(`${where}: expected an object`);
    return;
  }
  const s = spec as Record<string, unknown>;
  const from = (s.from ?? "text") as string;
  if (!["text", "value", "attribute", "count", "url"].includes(from)) problems.push(`${where}.from: unknown source "${from}"`);
  if (from === "attribute" && typeof s.attribute !== "string") problems.push(`${where}: from=attribute needs an attribute name`);
  const as = (s.as ?? "text") as string;
  if (!["text", "number", "integer", "boolean"].includes(as)) problems.push(`${where}.as: unknown type "${as}"`);
  if (s.selector !== undefined && typeof s.selector !== "string") problems.push(`${where}.selector: must be a string`);
  if (s.strip !== undefined) {
    if (typeof s.strip !== "string") problems.push(`${where}.strip: must be a regex source string`);
    else {
      try {
        new RegExp(s.strip);
      } catch (err) {
        problems.push(`${where}.strip: invalid regex (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
}

function validatePredicate(pred: unknown, pack: CheckPack, problems: string[], where: string): void {
  if (pred === null || typeof pred !== "object") {
    problems.push(`${where}: expected a predicate object`);
    return;
  }
  const p = pred as Record<string, any>;
  if (!PREDICATE_KINDS.includes(p.kind)) {
    problems.push(`${where}.kind: unknown predicate "${p.kind}" (known: ${PREDICATE_KINDS.join(", ")})`);
    return;
  }
  const needSelector = ["element_visible", "element_hidden", "count_equals", "attribute_equals", "list_order", "list_membership"];
  if (needSelector.includes(p.kind) && typeof p.selector !== "string") problems.push(`${where}: kind=${p.kind} needs a selector`);
  if (typeof p.selector === "string") resolveSelector(pack, p.selector, problems, where);
  if ((p.kind === "text_present" || p.kind === "text_absent") && typeof p.text !== "string") problems.push(`${where}: kind=${p.kind} needs text`);
  if (p.kind === "url_matches" && typeof p.pattern !== "string") problems.push(`${where}: kind=url_matches needs a pattern`);
  if (p.kind === "attribute_equals" && typeof p.attribute !== "string") problems.push(`${where}: kind=attribute_equals needs an attribute`);
  if (p.kind === "list_order") {
    if (!["sequence", "ascending", "descending"].includes(p.mode)) problems.push(`${where}.mode: must be sequence, ascending or descending`);
    if (p.mode === "sequence" && !Array.isArray(p.expected)) problems.push(`${where}: mode=sequence needs an expected array`);
  }
  if (p.kind === "list_membership" && !Array.isArray(p.contains) && !Array.isArray(p.not_contains)) {
    problems.push(`${where}: kind=list_membership needs contains and/or not_contains`);
  }
  for (const key of ["actual", "min", "max"]) {
    if (p[key] !== undefined) validateReadSpec(p[key], problems, `${where}.${key}`);
  }
  for (const key of ["expected", "left", "right"]) {
    if (p[key] !== undefined) validateValueRef(p[key], problems, `${where}.${key}`);
  }
  if (p.tolerance !== undefined && (typeof p.tolerance !== "number" || p.tolerance < 0)) problems.push(`${where}.tolerance: must be a non-negative number`);
}

function validateStep(step: unknown, pack: CheckPack, problems: string[], where: string): void {
  if (step === null || typeof step !== "object") {
    problems.push(`${where}: expected a step object`);
    return;
  }
  const s = step as Record<string, any>;
  if (!STEP_OPS.includes(s.op)) {
    problems.push(`${where}.op: unknown step "${s.op}" (known: ${STEP_OPS.join(", ")})`);
    return;
  }
  const selectorOps = ["click", "type", "wait_for"];
  if (selectorOps.includes(s.op) && typeof s.selector !== "string") problems.push(`${where}: op=${s.op} needs a selector`);
  if (typeof s.selector === "string") resolveSelector(pack, s.selector, problems, where);
  if (s.op === "type" && typeof s.text !== "string") problems.push(`${where}: op=type needs text`);
  if (s.op === "navigate" && typeof s.path !== "string" && typeof s.url !== "string") problems.push(`${where}: op=navigate needs path or url`);
  if (s.op === "read_many" && (typeof s.name !== "string" || typeof s.selector !== "string")) problems.push(`${where}: op=read_many needs name and selector`);
  if (s.op === "read") {
    if (typeof s.name !== "string" || s.name.trim() === "") problems.push(`${where}: op=read needs a name`);
    validateReadSpec(s, problems, where);
  }
  if (s.op === "wait_for_text" && typeof s.text !== "string") problems.push(`${where}: op=wait_for_text needs text`);
  if (s.op === "wait_for_text" && s.selector !== undefined && typeof s.selector !== "string") problems.push(`${where}.selector: must be a string`);
  if (s.op === "note" && typeof s.text !== "string") problems.push(`${where}: op=note needs text`);
  if (s.op === "expect") validatePredicate(s.expect, pack, problems, `${where}.expect`);
}

export function validatePack(pack: unknown): CheckPack {
  const problems: string[] = [];
  if (pack === null || typeof pack !== "object") throw new SpecError(["the pack must be a JSON object"]);
  const p = pack as Record<string, any>;
  if (p.spec_version !== CHECK_SPEC_VERSION) {
    problems.push(`spec_version: this engine understands spec_version ${CHECK_SPEC_VERSION}, the pack says ${JSON.stringify(p.spec_version)}`);
  }
  if (typeof p.pack_id !== "string" || p.pack_id.trim() === "") problems.push("pack_id: required, non-empty string");
  if (typeof p.pack_version !== "string" || p.pack_version.trim() === "") problems.push("pack_version: required, non-empty string");
  if (p.selectors !== undefined) {
    if (p.selectors === null || typeof p.selectors !== "object" || Array.isArray(p.selectors)) problems.push("selectors: must be an object of name -> CSS");
    else {
      for (const [name, css] of Object.entries(p.selectors as Record<string, unknown>)) {
        if (typeof css !== "string" || css.trim() === "") problems.push(`selectors.${name}: must be a non-empty CSS string`);
      }
    }
  }
  if (p.requirements !== undefined) {
    if (!Array.isArray(p.requirements)) problems.push("requirements: must be an array of {id, text}");
    else {
      const seen = new Set<string>();
      p.requirements.forEach((r: any, i: number) => {
        if (!r || typeof r.id !== "string" || r.id.trim() === "") problems.push(`requirements[${i}]: needs a non-empty id`);
        else if (seen.has(r.id)) problems.push(`requirements[${i}]: duplicate requirement id ${r.id}`);
        else seen.add(r.id);
      });
    }
  }
  if (!Array.isArray(p.checks) || p.checks.length === 0) {
    problems.push("checks: at least one check is required");
  } else {
    const ids = new Set<string>();
    p.checks.forEach((check: any, i: number) => {
      const where = `checks[${i}]${check && typeof check.id === "string" ? ` (${check.id})` : ""}`;
      if (!check || typeof check !== "object") {
        problems.push(`${where}: expected an object`);
        return;
      }
      if (typeof check.id !== "string" || check.id.trim() === "") problems.push(`${where}.id: required, non-empty string`);
      else if (ids.has(check.id)) problems.push(`${where}.id: duplicate check id ${check.id}`);
      else ids.add(check.id);
      if (typeof check.requirement_id !== "string" || check.requirement_id.trim() === "") {
        problems.push(`${where}.requirement_id: required -- a check that is not bound to a requirement cannot report coverage`);
      }
      if (typeof check.description !== "string" || check.description.trim() === "") problems.push(`${where}.description: required, plain language`);
      const steps = check.steps;
      if (steps !== undefined && !Array.isArray(steps)) problems.push(`${where}.steps: must be an array`);
      else if (Array.isArray(steps)) steps.forEach((s: unknown, j: number) => validateStep(s, p as unknown as CheckPack, problems, `${where}.steps[${j}]`));
      if (check.expect !== undefined) validatePredicate(check.expect, p as unknown as CheckPack, problems, `${where}.expect`);
      if (check.expect === undefined && (!Array.isArray(steps) || steps.length === 0)) {
        problems.push(`${where}: a check needs steps, an expect, or both`);
      }
      if (check.timeout_ms !== undefined && (typeof check.timeout_ms !== "number" || check.timeout_ms <= 0)) problems.push(`${where}.timeout_ms: must be a positive number`);
    });
  }
  if (problems.length > 0) throw new SpecError(problems);
  return p as unknown as CheckPack;
}

export function validateRequirementSet(value: unknown): RequirementSet {
  const problems: string[] = [];
  const list = Array.isArray(value) ? value : (value as Record<string, any>)?.requirements;
  if (!Array.isArray(list)) throw new SpecError(["a requirement set must be an array of {id, text} or an object with a `requirements` array"]);
  const seen = new Set<string>();
  list.forEach((r: any, i: number) => {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || r.id.trim() === "") problems.push(`requirements[${i}]: needs a non-empty id`);
    else if (seen.has(r.id)) problems.push(`requirements[${i}]: duplicate id ${r.id}`);
    else seen.add(r.id);
  });
  if (problems.length > 0) throw new SpecError(problems);
  const meta = Array.isArray(value) ? {} : ((value as Record<string, any>) ?? {});
  return {
    set_id: typeof meta.set_id === "string" ? meta.set_id : null as unknown as string,
    version: typeof meta.version === "string" ? meta.version : (null as unknown as string),
    requirements: list.map((r: any) => ({ id: r.id, text: typeof r.text === "string" ? r.text : undefined })),
  };
}

/** Union of requirement ids declared by the pack (and/or an external set). */
export function collectRequirements(pack: CheckPack, external: RequirementSet | null): { id: string; text: string | null; source: "pack" | "file" | "pack+file" | "none" }[] {
  const out = new Map<string, { id: string; text: string | null; source: "pack" | "file" | "pack+file" | "none" }>();
  for (const r of external?.requirements ?? []) out.set(r.id, { id: r.id, text: r.text ?? null, source: "file" });
  for (const r of pack.requirements ?? []) {
    const existing = out.get(r.id);
    if (existing) {
      out.set(r.id, { id: r.id, text: existing.text ?? r.text ?? null, source: "pack+file" });
    } else {
      out.set(r.id, { id: r.id, text: r.text ?? null, source: "pack" });
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function checkIdsByRequirement(pack: CheckPack): Map<string, CheckSpec[]> {
  const map = new Map<string, CheckSpec[]>();
  for (const check of pack.checks) {
    const list = map.get(check.requirement_id) ?? [];
    list.push(check);
    map.set(check.requirement_id, list);
  }
  return map;
}

export type { Predicate, Step };
