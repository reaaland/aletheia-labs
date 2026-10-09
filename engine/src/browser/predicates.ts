/**
 * Predicate evaluation.
 *
 * A predicate is the declarative "what should be true". Evaluating one produces
 * an outcome plus the two strings that go into the receipt: what was OBSERVED
 * and what was EXPECTED. Nothing here infers: a predicate either matched the
 * page or it did not, and every comparison is recorded with the values it used.
 *
 * Reading always goes through the driver session, so every navigation, click,
 * read and screenshot it causes appears in the check's action log.
 */
import { evaluate } from "./expr.ts";
import { renderUsed } from "./expr.ts";
import { StepError, type BrowserSession } from "./driver.ts";
import type { Predicate, ReadAs, ReadFrom, ReadSpec, ValueRef } from "./types.ts";

export type VarValue = string | number | boolean | null;

export interface VarEntry {
  name: string;
  raw: VarValue;
  value: VarValue;
  as: ReadAs;
  from: ReadFrom;
  selector: string | null;
  resolved_selector: string | null;
  url: string;
  timestamp: string;
}

export interface PredicateContext {
  session: BrowserSession;
  vars: Map<string, VarEntry>;
  resolve: (ref: string) => string;
  timeoutMs: number;
  /** Records a read against the check's evidence trail. */
  recordRead: (entry: VarEntry) => void;
}

export interface PredicateResult {
  outcome: "pass" | "fail" | "error";
  observed: string | null;
  expected: string | null;
  detail: string;
}

function toNumber(raw: VarValue, as: ReadAs, strip: string | null | undefined, name: string): number {
  if (typeof raw === "number") return raw;
  let text = raw === null || raw === undefined ? "" : String(raw);
  if (strip) text = text.replace(new RegExp(strip, "g"), "");
  else text = text.replace(/[^0-9eE.+-]/g, "");
  const n = Number(text.trim());
  if (!Number.isFinite(n)) throw new Error(`"${name}" is not a number (raw ${JSON.stringify(raw)})`);
  return as === "integer" ? Math.trunc(n) : n;
}

function coerce(raw: VarValue, as: ReadAs, strip: string | null | undefined, name: string): VarValue {
  if (as === "text") return raw === null || raw === undefined ? "" : String(raw).replace(/\s+/g, " ").trim();
  if (as === "boolean") return raw === true || String(raw).toLowerCase() === "true";
  return toNumber(raw, as, strip, name);
}

/** Read one value out of the page, applying the spec's `from`/`as`/`strip`. */
export async function readSpec(ctx: PredicateContext, spec: ReadSpec, name: string, timeoutMs?: number): Promise<VarEntry> {
  const from: ReadFrom = spec.from ?? "text";
  const as: ReadAs = spec.as ?? "text";
  const resolved = spec.selector ? ctx.resolve(spec.selector) : null;
  const needsSelector = from !== "url";
  if (needsSelector && !spec.selector) throw new Error(`read "${name}" needs a selector (only from=url may omit one)`);
  const raw = await ctx.session.read(resolved, from, spec.attribute ?? null, timeoutMs ?? ctx.timeoutMs);
  let rawValue: VarValue;
  switch (from) {
    case "count":
      rawValue = raw.count;
      break;
    case "value":
      rawValue = raw.value;
      break;
    case "attribute":
      rawValue = raw.value;
      break;
    case "url":
      rawValue = raw.url;
      break;
    default:
      rawValue = raw.text;
  }
  const entry: VarEntry = {
    name,
    raw: rawValue,
    value: coerce(rawValue, as, spec.strip, name),
    as,
    from,
    selector: spec.selector ?? null,
    resolved_selector: resolved,
    url: raw.url,
    timestamp: new Date().toISOString(),
  };
  ctx.vars.set(name, entry);
  ctx.recordRead(entry);
  return entry;
}

interface ResolvedValue {
  text: string;
  numeric: number | null;
  display: string;
}

/**
 * Turn a ValueRef into a concrete value. `{expr, vars}` reads its inputs out of
 * the page first (that is why this is async), then evaluates the arithmetic
 * deterministically and reports which variables it used.
 */
export async function resolveValueRef(ctx: PredicateContext, ref: ValueRef, label: string): Promise<ResolvedValue> {
  if ("var" in ref) {
    const entry = ctx.vars.get(ref.var);
    if (!entry) throw new Error(`${label} references "${ref.var}", which no earlier step read`);
    return {
      text: String(entry.value ?? ""),
      numeric: typeof entry.value === "number" ? entry.value : null,
      display: `${ref.var} = ${JSON.stringify(entry.value)} (read from ${entry.resolved_selector ?? entry.from} at ${entry.url})`,
    };
  }
  if ("value" in ref) {
    const v = ref.value;
    return { text: String(v), numeric: typeof v === "number" ? v : Number.isFinite(Number(v)) && String(v).trim() !== "" && /^-?[0-9.]+$/.test(String(v).trim()) ? Number(v) : null, display: JSON.stringify(v) };
  }
  for (const [name, spec] of Object.entries(ref.vars ?? {})) {
    await readSpec(ctx, spec as ReadSpec, name);
  }
  const numericVars: Record<string, number> = {};
  for (const [name, entry] of ctx.vars) {
    if (typeof entry.value === "number") numericVars[name] = entry.value;
  }
  const result = evaluate(ref.expr, numericVars);
  if (!result.ok) throw new Error(`${label}: ${result.error}`);
  return {
    text: String(result.value),
    numeric: result.value,
    display: `${ref.expr} = ${result.value} [${renderUsed(result.used)}]`,
  };
}

function numbersDiffer(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) > tolerance;
}

function describeTextList(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

function shorten(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export async function evaluatePredicate(pred: Predicate, ctx: PredicateContext): Promise<PredicateResult> {
  const p = pred as Record<string, any>;
  const message = typeof p.message === "string" ? `${p.message} ` : "";
  try {
    switch (p.kind as Predicate["kind"]) {
      case "text_present":
      case "text_absent": {
        const selector = typeof p.selector === "string" ? ctx.resolve(p.selector) : null;
        const text = await ctx.session.visibleText(selector, ctx.timeoutMs);
        const mode = p.mode === "equals" ? "equals" : "contains";
        const found = mode === "equals" ? text.trim() === p.text : text.includes(p.text);
        const observed = `${mode === "equals" ? "exact text" : "visible text contains"} ${JSON.stringify(p.text)} -> ${found ? "found" : "not found"}; page text: ${JSON.stringify(shorten(text))}`;
        const expected = `${message}the page ${p.kind === "text_present" ? "shows" : "does not show"} the text ${JSON.stringify(p.text)}`;
        if (p.kind === "text_present") {
          return found
            ? { outcome: "pass", observed, expected, detail: `the required text is present` }
            : { outcome: "fail", observed, expected, detail: `the required text ${JSON.stringify(p.text)} was not found` };
        }
        return found
          ? { outcome: "fail", observed, expected, detail: `the forbidden text ${JSON.stringify(p.text)} is present` }
          : { outcome: "pass", observed, expected, detail: `the forbidden text is absent` };
      }
      case "element_visible":
      case "element_hidden": {
        const css = ctx.resolve(p.selector);
        const read = await ctx.session.read(css, "count", null, ctx.timeoutMs);
        const visible = read.count > 0 && read.visible;
        const observed = `matched ${read.count} element(s); visible: ${visible}`;
        const expected = `${message}${p.kind === "element_visible" ? "an element is visible" : "an element is hidden or absent"} (${css})`;
        const ok = p.kind === "element_visible" ? visible : !visible;
        return { outcome: ok ? "pass" : "fail", observed, expected, detail: ok ? "as required" : "the page did not match the requirement" };
      }
      case "count_equals": {
        const css = ctx.resolve(p.selector);
        const read = await ctx.session.read(css, "count", null, ctx.timeoutMs);
        const expected = await resolveValueRef(ctx, p.expected as ValueRef, "count_equals.expected");
        const tolerance = p.tolerance ?? 0;
        const ok = expected.numeric !== null && Math.abs(read.count - expected.numeric) <= tolerance;
        return {
          outcome: ok ? "pass" : "fail",
          observed: `${read.count} element(s) matching ${css}`,
          expected: `${message}${expected.display}`,
          detail: ok ? "count matched" : `count ${read.count} did not match ${expected.text}`,
        };
      }
      case "attribute_equals": {
        const css = ctx.resolve(p.selector);
        const read = await ctx.session.read(css, "attribute", p.attribute, ctx.timeoutMs);
        const expected = await resolveValueRef(ctx, p.expected as ValueRef, "attribute_equals.expected");
        const observedRaw = read.value;
        const ok = String(observedRaw ?? "") === expected.text;
        return {
          outcome: read.count === 0 ? "error" : ok ? "pass" : "fail",
          observed: `${p.attribute}=${JSON.stringify(observedRaw)} (${read.count} element(s) matched)`,
          expected: `${message}${p.attribute}=${expected.text}`,
          detail: read.count === 0 ? `no element matched ${css}, so the attribute could not be read` : ok ? "attribute matched" : "attribute differed",
        };
      }
      case "value_equals": {
        const actualEntry = await readSpec(ctx, p.actual as ReadSpec, "actual");
        const expected = await resolveValueRef(ctx, p.expected as ValueRef, "value_equals.expected");
        const tolerance = p.tolerance ?? 1e-6;
        if (typeof actualEntry.value === "number" && expected.numeric !== null) {
          const ok = !numbersDiffer(actualEntry.value, expected.numeric, tolerance);
          return {
            outcome: ok ? "pass" : "fail",
            observed: `${actualEntry.value} (read from ${actualEntry.resolved_selector ?? actualEntry.from})`,
            expected: `${message}${expected.display}${tolerance ? ` (tolerance ${tolerance})` : ""}`,
            detail: ok ? "the page's value matched the required value" : `expected ${expected.numeric} but the page showed ${actualEntry.value}`,
          };
        }
        const ok = String(actualEntry.value ?? "") === expected.text;
        return {
          outcome: ok ? "pass" : "fail",
          observed: JSON.stringify(actualEntry.value),
          expected: `${message}${expected.display}`,
          detail: ok ? "the value matched" : `expected ${expected.text}, found ${JSON.stringify(actualEntry.value)}`,
        };
      }
      case "value_in_range": {
        const actualEntry = await readSpec(ctx, p.actual as ReadSpec, "actual");
        const min = p.min !== undefined ? await resolveValueRef(ctx, p.min as ValueRef, "value_in_range.min") : null;
        const max = p.max !== undefined ? await resolveValueRef(ctx, p.max as ValueRef, "value_in_range.max") : null;
        const tolerance = p.tolerance ?? 0;
        const n = typeof actualEntry.value === "number" ? actualEntry.value : Number(actualEntry.value);
        if (!Number.isFinite(n)) {
          return { outcome: "error", observed: JSON.stringify(actualEntry.value), expected: "a number", detail: "the value read from the page is not numeric, so it cannot be range-checked" };
        }
        const ok = (min === null || n >= min.numeric! - tolerance) && (max === null || n <= max.numeric! + tolerance);
        return {
          outcome: ok ? "pass" : "fail",
          observed: String(n),
          expected: `${message}${min ? `>= ${min.text}` : ""}${min && max ? " and " : ""}${max ? `<= ${max.text}` : ""}`,
          detail: ok ? "inside the required range" : "outside the required range",
        };
      }
      case "cross_page_agrees": {
        const left = await resolveValueRef(ctx, p.left as ValueRef, "cross_page_agrees.left");
        const right = await resolveValueRef(ctx, p.right as ValueRef, "cross_page_agrees.right");
        const requireDifferentPages = p.require_different_pages !== false;
        const leftVar = "var" in (p.left as any) ? ctx.vars.get((p.left as any).var) : null;
        const rightVar = "var" in (p.right as any) ? ctx.vars.get((p.right as any).var) : null;
        const leftUrl = leftVar?.url ?? ctx.session.currentUrl();
        const rightUrl = rightVar?.url ?? ctx.session.currentUrl();
        if (requireDifferentPages && leftUrl === rightUrl) {
          return {
            outcome: "error",
            observed: `both values came from ${leftUrl}`,
            expected: `${message}the same value read from two different pages`,
            detail: "this check claims to compare the same value across two pages, but both reads happened on one page; the check did not verify what it says it verifies",
          };
        }
        const tolerance = p.tolerance ?? (typeof left.numeric === "number" && typeof right.numeric === "number" ? 1e-6 : 0);
        const bothNumeric = left.numeric !== null && right.numeric !== null;
        const ok = bothNumeric ? !numbersDiffer(left.numeric as number, right.numeric as number, tolerance) : left.text === right.text;
        return {
          outcome: ok ? "pass" : "fail",
          observed: `${leftVar?.name ?? "left"} = ${left.text} (from ${leftUrl}) vs ${rightVar?.name ?? "right"} = ${right.text} (from ${rightUrl})`,
          expected: `${message}the same value on both pages`,
          detail: ok ? "both pages agreed" : "the two pages disagreed",
        };
      }
      case "list_order": {
        const css = ctx.resolve(p.selector);
        const items = await ctx.session.readAll(css, p.item ?? null, ctx.timeoutMs);
        const mode = p.mode as "sequence" | "ascending" | "descending";
        if (mode === "sequence") {
          const expectedList = (p.expected as string[]).map((s) => String(s).replace(/\s+/g, " ").trim());
          const observedList = items.map((s) => s.replace(/\s+/g, " ").trim());
          const ok = observedList.length === expectedList.length && observedList.every((v, i) => v === expectedList[i]);
          return {
            outcome: ok ? "pass" : "fail",
            observed: describeTextList(observedList),
            expected: `${message}in this order: ${describeTextList(expectedList)}`,
            detail: ok ? "the list appeared in the required order" : "the list order or membership differed from the requirement",
          };
        }
        const strip = p.item?.strip ?? null;
        const nums = items.map((raw, i) => {
          const text = strip ? String(raw).replace(new RegExp(strip, "g"), "") : String(raw).replace(/[^0-9eE.+-]/g, "");
          const n = Number(text.trim());
          if (!Number.isFinite(n)) throw new Error(`item ${i + 1} (${JSON.stringify(raw)}) is not numeric, so ${mode} order cannot be checked`);
          return n;
        });
        const ok = nums.every((v, i) => (i === 0 ? true : mode === "ascending" ? nums[i - 1] <= v : nums[i - 1] >= v));
        return {
          outcome: ok ? "pass" : "fail",
          observed: `[${nums.join(", ")}]`,
          expected: `${message}values in ${mode} order`,
          detail: ok ? `the list is in ${mode} order` : `the list is not in ${mode} order`,
        };
      }
      case "list_membership": {
        const css = ctx.resolve(p.selector);
        const items = (await ctx.session.readAll(css, p.item ?? null, ctx.timeoutMs)).map((s) => s.replace(/\s+/g, " ").trim());
        const contains = (p.contains as string[] | undefined)?.map((s) => s.replace(/\s+/g, " ").trim()) ?? [];
        const notContains = (p.not_contains as string[] | undefined)?.map((s) => s.replace(/\s+/g, " ").trim()) ?? [];
        const missing = contains.filter((want) => !items.some((have) => have === want || have.includes(want)));
        const unexpected = notContains.filter((want) => items.some((have) => have === want || have.includes(want)));
        const ok = missing.length === 0 && unexpected.length === 0;
        return {
          outcome: ok ? "pass" : "fail",
          observed: describeTextList(items),
          expected: `${message}${contains.length ? `contains ${describeTextList(contains)}` : ""}${contains.length && notContains.length ? " and " : ""}${notContains.length ? `does not contain ${describeTextList(notContains)}` : ""}`,
          detail: ok ? "membership matched" : `${missing.length ? `missing: ${describeTextList(missing)}. ` : ""}${unexpected.length ? `unexpectedly present: ${describeTextList(unexpected)}` : ""}`.trim(),
        };
      }
      case "url_matches": {
        const url = ctx.session.currentUrl();
        const mode = p.mode === "equals" ? "equals" : "contains";
        const ok = mode === "equals" ? url === p.pattern : url.includes(p.pattern);
        return {
          outcome: ok ? "pass" : "fail",
          observed: url,
          expected: `${message}url ${mode} ${JSON.stringify(p.pattern)}`,
          detail: ok ? "url matched" : "url did not match",
        };
      }
      default:
        return { outcome: "error", observed: null, expected: null, detail: `unknown predicate kind ${JSON.stringify(p.kind)}` };
    }
  } catch (err) {
    if (err instanceof StepError) {
      return { outcome: "error", observed: null, expected: `${message}${p.kind}`, detail: err.message };
    }
    return {
      outcome: "error",
      observed: null,
      expected: `${message}${p.kind}`,
      detail: `the expectation could not be evaluated: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
