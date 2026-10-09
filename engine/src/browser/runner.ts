/**
 * The check runner.
 *
 * One session per check: a fresh browser context, its own trace, its own
 * screenshot directory. That is deliberate -- two checks can never contaminate
 * each other, and the evidence for a check is complete on its own.
 *
 * A step that cannot be executed (a missing selector, a wait that never comes
 * true) ends THAT check as `error` and records the step that failed. It never
 * ends the run: the remaining checks still execute, because a run that stops at
 * the first obstacle reports less than the evidence supports.
 */
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ENGINE_VERSION } from "../util/ids.ts";
import { canonicalJson, hashHex, nowIso } from "../util/ids.ts";
import type { Env } from "../types.ts";
import { driverCandidates } from "./registry.ts";
import { StepError, type BrowserHandle, type BrowserSession } from "./driver.ts";
import { evaluatePredicate, readSpec, type PredicateContext, type VarEntry } from "./predicates.ts";
import { resolveSelector } from "./spec.ts";
import { buildCoverage, selectedChecks } from "./coverage.ts";
import { renderMarkdownReport } from "./render.ts";
import type {
  ActionRecord,
  CheckPack,
  CheckResult,
  CheckSpec,
  CoverageReport,
  Predicate,
  ReadRecord,
  Step,
  VerificationRun,
} from "./types.ts";

export interface RunnerOptions {
  pack: CheckPack;
  packPath: string;
  packSha256: string;
  baseUrl: string;
  artifactsDir: string;
  env: Env;
  /** driver id, or null/"auto" to try every available driver in order. */
  driver?: string | null;
  /** Only run these check ids; everything else is reported as not executed. */
  only?: string[] | null;
  recordTrace?: boolean;
  screenshots?: boolean;
  headless?: boolean;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  runId?: string;
  requirementIds?: { id: string; text: string | null; source: "pack" | "file" | "pack+file" | "none" }[];
  requirementSetMeta?: { set_id: string | null; version: string | null; sha256: string | null; source: VerificationRun["requirement_set"]["source"] };
  log?: (line: string) => void;
  now?: () => Date;
}

export interface RunnerResult {
  run: VerificationRun;
  markdown: string;
  /** True when the browser really started and checks really executed. */
  executed: boolean;
}

const DEFAULTS = { viewport: { width: 1280, height: 900 }, timeoutMs: 5_000 };

function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path) || path.startsWith("data:") || path.startsWith("about:")) return path;
  if (path.startsWith("/")) return `${baseUrl.replace(/\/+$/, "")}${path}`;
  return `${baseUrl.replace(/\/+$/, "")}/${path}`;
}

export async function runCheckPack(opts: RunnerOptions): Promise<RunnerResult> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (() => new Date());
  const viewport = opts.viewport ?? DEFAULTS.viewport;
  const defaultTimeout = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const recordTrace = opts.recordTrace !== false;
  const screenshots = opts.screenshots !== false;
  const notes: string[] = [];

  const runId = opts.runId ?? `verify-${opts.pack.pack_id}-${now().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${crypto.randomUUID().slice(0, 6)}`;
  const runDir = join(opts.artifactsDir, runId);
  mkdirSync(runDir, { recursive: true });

  const chosen = driverCandidates(opts.env, opts.driver ?? null);
  notes.push(...chosen.notes);

  let handle: BrowserHandle | null = null;
  const launchFailures: string[] = [];
  for (const candidate of chosen.candidates) {
    try {
      log(`starting browser driver ${candidate.id} ...`);
      handle = await candidate.launch({ env: opts.env, headless: opts.headless !== false, fingerprint: viewport });
      break;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const fallback = chosen.candidates.indexOf(candidate) < chosen.candidates.length - 1;
      launchFailures.push(`${candidate.id}: ${reason}`);
      notes.push(`browser driver ${candidate.id} could not start (${reason})${fallback ? "; falling through to the next independent driver" : ""}`);
    }
  }
  if (!handle) {
    throw new Error(`no browser driver could be started: ${launchFailures.join(" | ")}`);
  }
  notes.push(`driver in use: ${handle.id} (${handle.label}); browser binary ${handle.executable} from ${handle.executableSource}`);
  if (handle.id === "cdp") {
    notes.push(
      "the CDP driver performs clicks and typing with scripted DOM calls rather than synthesized input events; each trace event says which mechanism was used",
    );
  }

  const checks = selectedChecks(opts.pack, opts.only ?? null);
  const results: CheckResult[] = [];
  let checkedCount = 0;

  try {
    for (const check of checks) {
      checkedCount += 1;
      log(`check ${checkedCount}/${checks.length}: ${check.id} -> ${check.requirement_id}`);
      results.push(await runOneCheck(check, handle, { ...opts, runId, runDir, viewport, defaultTimeout, recordTrace, screenshots, now, log }));
    }
  } finally {
    await handle.close();
  }

  const coverage = buildCoverage({
    pack: opts.pack,
    results,
    selectedIds: checks.map((c) => c.id),
    requirementIds: opts.requirementIds,
  });

  const outcomeDigest = digestOutcomes(results);
  const run: VerificationRun = {
    kind: "verification",
    run_id: runId,
    timestamp: now().toISOString(),
    engine_version: ENGINE_VERSION,
    driver: { id: handle.id, label: handle.label, executable: handle.executable },
    pack: { id: opts.pack.pack_id, version: opts.pack.pack_version, spec_version: opts.pack.spec_version, sha256: opts.packSha256, path: opts.packPath },
    requirement_set: opts.requirementSetMeta ?? { set_id: null, version: null, sha256: null, source: opts.pack.requirements?.length ? "pack" : "none" },
    app: { base_url: opts.baseUrl, app_version: opts.pack.app_version ?? null },
    outcome_digest: outcomeDigest,
    checks: results,
    coverage,
    artifacts: {
      run_dir: runDir,
      run_json: join(runDir, "run.json"),
      report_markdown: join(runDir, "report.md"),
      coverage_json: join(runDir, "coverage.json"),
    },
    notes,
    prev_hash: null,
    hash: "",
  };

  return { run, markdown: renderMarkdownReport(run), executed: results.length > 0 };
}

/** sha256 over only the outcome-bearing fields: same inputs, same digest. */
export function digestOutcomes(results: CheckResult[]): string {
  const canonical = canonicalJson(
    results
      .map((r) => ({
        check_id: r.check_id,
        requirement_id: r.requirement_id,
        outcome: r.outcome,
        observed: r.observed,
        expected: r.expected,
        detail: r.detail,
        error: r.error ? { step_index: r.error.step_index, op: r.error.op, message: r.error.message } : null,
        actions: r.actions.map((a) => ({ op: a.op, selector: a.resolved_selector, value: a.value, status: a.status })),
        reads: r.reads.map((x) => ({ name: x.name, value: x.value, url: x.url })),
      }))
      .sort((a, b) => a.check_id.localeCompare(b.check_id)),
  );
  return hashHex(canonical);
}

interface CheckRunContext extends RunnerOptions {
  runId: string;
  runDir: string;
  viewport: { width: number; height: number };
  defaultTimeout: number;
  recordTrace: boolean;
  screenshots: boolean;
  now: () => Date;
  log: (line: string) => void;
}

async function runOneCheck(check: CheckSpec, handle: BrowserHandle, ctx: CheckRunContext): Promise<CheckResult> {
  const checkDir = join(ctx.runDir, "checks", check.id);
  mkdirSync(checkDir, { recursive: true });
  const startedAt = ctx.now().toISOString();
  const startedMs = Date.now();
  const timeoutMs = check.timeout_ms ?? ctx.defaultTimeout;

  const actions: ActionRecord[] = [];
  const reads: ReadRecord[] = [];
  const screenshotsTaken: string[] = [];
  const selectorsUsed: Record<string, string> = {};
  const vars = new Map<string, VarEntry>();
  let finalScreenshot: string | null = null;

  const rel = (abs: string): string => relative(ctx.runDir, abs).split("\\").join("/");

  const session = await handle.openSession({
    artifactDir: checkDir,
    timeoutMs,
    viewport: ctx.viewport,
    recordTrace: ctx.recordTrace,
  });

  const predicateOutcomes: { outcome: "pass" | "fail" | "error"; observed: string | null; expected: string | null; detail: string }[] = [];
  let stepError: { step_index: number; op: string; message: string } | null = null;
  let actionIndex = 0;

  const resolve = (ref: string): string => {
    const css = resolveSelector(ctx.pack, ref, [], "runtime");
    selectorsUsed[ref] = css;
    return css;
  };

  const predicateContext: PredicateContext = {
    session,
    vars,
    resolve,
    timeoutMs,
    recordRead: (entry) => {
      reads.push({
        name: entry.name,
        selector: entry.selector,
        resolved_selector: entry.resolved_selector,
        from: entry.from,
        as: entry.as,
        raw: entry.raw,
        value: entry.value,
        url: entry.url,
        timestamp: entry.timestamp,
      });
    },
  };

  const steps: Step[] = [...(check.steps ?? [])];
  if (check.expect) steps.push({ op: "expect", expect: check.expect });

  const record = async (op: string, selectorRef: string | null, value: string | null, note: string | null, fn: () => Promise<{ payload?: string } | void>): Promise<void> => {
    actionIndex += 1;
    const entry: ActionRecord = {
      index: actionIndex,
      op,
      selector: selectorRef,
      resolved_selector: selectorRef ? resolve(selectorRef) : null,
      value,
      url: session.currentUrl(),
      status: "ok",
      started_at: ctx.now().toISOString(),
      duration_ms: 0,
      note,
      error: null,
    };
    const t0 = Date.now();
    try {
      await fn();
      entry.duration_ms = Date.now() - t0;
      entry.url = session.currentUrl();
      actions.push(entry);
    } catch (err) {
      entry.duration_ms = Date.now() - t0;
      entry.status = "error";
      entry.error = err instanceof Error ? err.message : String(err);
      entry.url = session.currentUrl();
      actions.push(entry);
      throw err;
    }
  };

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (stepError) break;
    try {
      switch (step.op) {
        case "navigate": {
          const target = step.url ?? joinUrl(ctx.baseUrl, step.path ?? "/");
          await record("navigate", null, target, step.note ?? null, async () => {
            await session.goto(target, step.wait_until ?? "load");
          });
          break;
        }
        case "click": {
          await record("click", step.selector, null, step.note ?? null, async () => {
            await session.click(resolve(step.selector), timeoutMs);
          });
          break;
        }
        case "type": {
          await record("type", step.selector, step.text, step.note ?? null, async () => {
            await session.type(resolve(step.selector), step.text, {
              clear: step.clear !== false,
              pressEnter: step.press_enter === true,
              timeoutMs,
            });
          });
          break;
        }
        case "wait_for": {
          await record("wait_for", step.selector, step.state ?? "visible", step.note ?? null, async () => {
            await session.waitFor(resolve(step.selector), step.state ?? "visible", step.timeout_ms ?? timeoutMs);
          });
          break;
        }
        case "wait_for_text": {
          await record("wait_for_text", step.selector ?? null, step.text, step.note ?? null, async () => {
            await session.waitForText(step.selector ? resolve(step.selector) : null, step.text, step.mode ?? "contains", step.timeout_ms ?? timeoutMs);
          });
          break;
        }
        case "read": {
          await record("read", step.selector ?? null, null, step.note ?? null, async () => {
            await readSpec(predicateContext, { selector: step.selector, from: step.from, attribute: step.attribute, as: step.as, strip: step.strip }, step.name, step.timeout_ms ?? timeoutMs);
          });
          break;
        }
        case "read_many": {
          await record("read_many", step.selector, null, step.note ?? null, async () => {
            const css = resolve(step.selector);
            const items = await session.readAll(css, step.item ?? null, timeoutMs);
            const entry: VarEntry = {
              name: step.name,
              raw: items.length,
              value: items.length,
              as: "integer",
              from: "count",
              selector: step.selector,
              resolved_selector: css,
              url: session.currentUrl(),
              timestamp: ctx.now().toISOString(),
            };
            vars.set(step.name, entry);
            predicateContext.recordRead(entry);
            // The items themselves are also recorded, so a list claim can cite them.
            for (let k = 0; k < items.length; k += 1) {
              const itemEntry: VarEntry = {
                name: `${step.name}[${k}]`,
                raw: items[k],
                value: items[k],
                as: "text",
                from: "text",
                selector: step.selector,
                resolved_selector: `${css} >> :nth-match(${k + 1})`,
                url: session.currentUrl(),
                timestamp: ctx.now().toISOString(),
              };
              vars.set(itemEntry.name, itemEntry);
              predicateContext.recordRead(itemEntry);
            }
          });
          break;
        }
        case "expect": {
          const outcome = await evaluatePredicate(step.expect as Predicate, predicateContext);
          actionIndex += 1;
          actions.push({
            index: actionIndex,
            op: "expect",
            selector: typeof (step.expect as Record<string, unknown>).selector === "string" ? ((step.expect as Record<string, unknown>).selector as string) : null,
            resolved_selector: null,
            value: (step.expect as { kind?: string }).kind ?? null,
            url: session.currentUrl(),
            status: outcome.outcome === "error" ? "error" : "ok",
            started_at: ctx.now().toISOString(),
            duration_ms: 0,
            note: (step.expect as { message?: string }).message ?? null,
            error: outcome.outcome === "error" ? outcome.detail : null,
          });
          predicateOutcomes.push(outcome);
          break;
        }
        case "screenshot": {
          if (ctx.screenshots) {
            const file = join(checkDir, `${String(actionIndex + 1).padStart(2, "0")}-${(step.label ?? "shot").replace(/[^A-Za-z0-9_-]+/g, "-")}.png`);
            await record("screenshot", null, rel(file), step.note ?? step.label ?? null, async () => {
              await session.screenshot(file, step.full_page === true);
            });
            screenshotsTaken.push(rel(file));
          } else {
            actionIndex += 1;
            actions.push({
              index: actionIndex,
              op: "screenshot",
              selector: null,
              resolved_selector: null,
              value: null,
              url: session.currentUrl(),
              status: "ok",
              started_at: ctx.now().toISOString(),
              duration_ms: 0,
              note: "screenshots disabled for this run",
              error: null,
            });
          }
          break;
        }
        case "note": {
          actionIndex += 1;
          actions.push({
            index: actionIndex,
            op: "note",
            selector: null,
            resolved_selector: null,
            value: null,
            url: session.currentUrl(),
            status: "ok",
            started_at: ctx.now().toISOString(),
            duration_ms: 0,
            note: step.text,
            error: null,
          });
          break;
        }
        default: {
          throw new StepError((step as { op: string }).op, null, `unknown step op`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stepError = { step_index: i, op: (step as { op: string }).op, message };
      ctx.log(`  step ${i + 1} (${(step as { op: string }).op}) could not be executed: ${message}`);
      break;
    }
  }

  // Final evidence: one screenshot of the state the check ended in, always.
  if (ctx.screenshots) {
    const file = join(checkDir, "final.png");
    try {
      await session.screenshot(file, false);
      finalScreenshot = rel(file);
      screenshotsTaken.push(finalScreenshot);
    } catch (err) {
      ctx.log(`  final screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let trace: { path: string; format: "playwright-zip" | "cdp-session-log"; events: number } | null = null;
  if (ctx.recordTrace) {
    const ext = handle.id === "playwright" ? "zip" : "jsonl";
    const file = join(checkDir, `trace.${ext}`);
    try {
      const t = await session.stopTrace(file);
      trace = { path: rel(file), format: t.format, events: t.events };
    } catch (err) {
      ctx.log(`  trace could not be written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const finalUrl = session.currentUrl();
  await session.close();

  const outcomes = predicateOutcomes.map((o) => o.outcome);
  const outcome: CheckResult["outcome"] = stepError
    ? "error"
    : outcomes.includes("error")
      ? "error"
      : outcomes.includes("fail")
        ? "fail"
        : outcomes.length === 0 && steps.length === 0
          ? "error"
          : "pass";

  const last = predicateOutcomes[predicateOutcomes.length - 1];
  const failedPredicate = predicateOutcomes.find((o) => o.outcome === "fail");
  const erroredPredicate = predicateOutcomes.find((o) => o.outcome === "error");
  const chosen = failedPredicate ?? erroredPredicate ?? last;

  const detail = stepError
    ? `step ${stepError.step_index + 1} (${stepError.op}) could not be executed, so this check did not run to completion: ${stepError.message}`
    : chosen
      ? chosen.detail
      : "the check executed but contained no expectation, so nothing was asserted";

  const finishedAt = ctx.now().toISOString();
  return {
    check_id: check.id,
    requirement_id: check.requirement_id,
    description: check.description,
    outcome,
    observed: chosen?.observed ?? null,
    expected: chosen?.expected ?? null,
    detail,
    error: stepError,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.now() - startedMs,
    run_id: ctx.runId,
    driver: handle.id,
    selectors: selectorsUsed,
    actions,
    reads,
    artifacts: {
      dir: rel(checkDir),
      screenshot: finalScreenshot,
      screenshots: screenshotsTaken,
      trace: trace?.path ?? null,
      trace_format: trace?.format ?? null,
      trace_events: trace?.events ?? 0,
    },
    final_url: finalUrl,
  };
}
