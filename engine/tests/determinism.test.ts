/**
 * Determinism of the outcome digest -- proven, not asserted.
 *
 * The claim under test is narrow and checkable: **the same check pack run twice
 * against the same application state produces the same `outcome_digest`.**
 *
 * A run in which everything passes proves nothing about that, because a passing
 * run has almost no text in it. Volatile text gets in through the checks that do
 * not pass: a step that could not be executed carries a driver message with a
 * timeout in it, a predicate that could not be evaluated carries the reason, and
 * the receipts for both are full of machine-written prose. So the runs below
 * deliberately contain a FAILING check and TWO ERRORING checks (one whose step
 * could not be executed, one whose expectation could not be evaluated), plus a
 * passing one so the run is a real run.
 *
 * Three things are proven here, and the third matters as much as the first two:
 *
 *  1. two runs against the same server produce the same digest -- and the two
 *     run records genuinely differ in their timestamps, durations, run ids and
 *     artifact paths, so the equality is not vacuous;
 *  2. the same pack against the same application state served on a DIFFERENT
 *     PORT also produces the same digest, because the port the app happened to
 *     be served on is not part of what was observed;
 *  3. the digest is still sensitive: changing an observed value, or an outcome,
 *     changes it. A digest that never changed would prove nothing either.
 *
 * The clock is NOT frozen in the runs below -- `now` is left at the real
 * implementation, so the timestamps and durations recorded are the real ones and
 * they really do differ between runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePack, verifyWebApp } from "../src/browser/index.ts";
import type { CheckPack, CheckResult, Env, VerificationRun } from "../src/browser/index.ts";
import { digestOutcomes, digestProjection, digestScopeForRun, normalizeVolatileText, VOLATILE_TEXT_RULES } from "../src/browser/digest.ts";

const webRoot = join(import.meta.dir, "..", "fixtures", "web");
const env = process.env as Env;

interface FixtureServer {
  base: string;
  stop: () => void;
}

/**
 * The application under test is the tiny page set this repository authors
 * itself. Two independent servers serve exactly the same bytes, so "the same
 * application state" can be served on two different ports.
 */
function serveFixtures(): FixtureServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(join(webRoot, path));
      return file.exists().then((ok) => (ok ? new Response(file) : new Response("not found", { status: 404 })));
    },
  });
  return { base: `http://127.0.0.1:${(server as { port: number }).port}`, stop: () => server.stop(true) };
}

let serverA: FixtureServer;
let serverB: FixtureServer;

beforeAll(() => {
  serverA = serveFixtures();
  serverB = serveFixtures();
});

afterAll(() => {
  serverA?.stop();
  serverB?.stop();
});

/**
 * A pack whose run contains a pass, a fail, a step that cannot be executed and
 * an expectation that cannot be evaluated.
 */
function determinismPack(): CheckPack {
  return validatePack({
    spec_version: 1,
    pack_id: "determinism-pack",
    pack_version: "1.0.0",
    description: "one run containing a passing, a failing and two errored checks",
    selectors: {
      subtotal: "[data-testid=subtotal]",
      lineTotalA: "[data-testid=line-total-A]",
      lineTotalB: "[data-testid=line-total-B]",
      lines: "tr.line",
      missingThing: "[data-testid=this-does-not-exist]",
    },
    checks: [
      {
        id: "d-passes",
        requirement_id: "R1",
        description: "the subtotal equals the sum of the two line totals",
        steps: [
          { op: "navigate", path: "/cart.html" },
          {
            op: "expect",
            expect: {
              kind: "value_equals",
              actual: { selector: "subtotal", as: "number", strip: "[^0-9.]" },
              expected: {
                expr: "line_a + line_b",
                vars: {
                  line_a: { selector: "lineTotalA", as: "number", strip: "[^0-9.]" },
                  line_b: { selector: "lineTotalB", as: "number", strip: "[^0-9.]" },
                },
              },
              tolerance: 0.005,
              message: "the subtotal must equal the line totals added up",
            },
          },
        ],
      },
      {
        id: "d-fails",
        requirement_id: "R2",
        description: "the cart advertises free shipping over $50",
        steps: [
          { op: "navigate", path: "/cart.html" },
          { op: "expect", expect: { kind: "text_present", text: "Free shipping", message: "shipping must be advertised" } },
        ],
      },
      {
        id: "d-errors-step",
        requirement_id: "R3",
        description: "the cart exposes a blocked-checkout state",
        steps: [
          { op: "navigate", path: "/cart.html" },
          // A selector that is not on the page, waited on with a configured
          // timeout. The message this produces quotes a DURATION -- the exact
          // shape of text that used to leak into the digest.
          { op: "wait_for", selector: "missingThing", state: "visible", timeout_ms: 400 },
        ],
      },
      {
        id: "d-errors-predicate",
        requirement_id: "R4",
        description: "the discount row shows a number",
        steps: [
          { op: "navigate", path: "/cart.html" },
          // An expectation that cannot be evaluated: the check reads a price as
          // text and then asks for it to be in a numeric range. This is the
          // ERROR path that comes from the PREDICATE rather than from a step,
          // and it is a real class of finding -- an inadequate test, not a
          // defective application.
          {
            op: "expect",
            expect: {
              kind: "value_in_range",
              actual: { selector: "subtotal", as: "text" },
              max: { value: 100 },
              message: "the subtotal must be a number under 100",
            },
          },
        ],
      },
      {
        id: "d-passes-after-errors",
        requirement_id: "R5",
        description: "the line items are listed cheapest unit price first",
        steps: [
          { op: "navigate", path: "/cart.html" },
          {
            op: "expect",
            expect: { kind: "list_order", selector: "lines", mode: "ascending", item: { sub_selector: ".unit", strip: "[^0-9.]" } },
          },
        ],
      },
    ],
  });
}

interface Harness {
  dir: string;
  artifacts: string;
  dbPath: string;
  packPath: string;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "aletheia-determinism-"));
  const packPath = join(dir, "pack.json");
  writeFileSync(packPath, `${JSON.stringify(determinismPack(), null, 2)}\n`, "utf8");
  return { dir, artifacts: join(dir, "artifacts"), dbPath: join(dir, "ledger.db"), packPath };
}

/** Run the pack with the REAL clock: nothing about time is stubbed out here. */
async function runAgainst(server: FixtureServer, h: Harness): Promise<VerificationRun> {
  const result = await verifyWebApp({
    env,
    packPath: h.packPath,
    baseUrl: server.base,
    artifactsDir: h.artifacts,
    dbPath: h.dbPath,
    databaseUrl: null,
  });
  return result.run;
}

function cloneResults(run: VerificationRun): CheckResult[] {
  return JSON.parse(JSON.stringify(run.checks)) as CheckResult[];
}

function checkById(run: VerificationRun, id: string): CheckResult {
  const found = run.checks.find((c) => c.check_id === id);
  if (!found) throw new Error(`no check ${id} in the run`);
  return found;
}

describe("two runs of the same pack against the same app state", () => {
  let first: VerificationRun;
  let second: VerificationRun;
  let third: VerificationRun;
  const dirs: string[] = [];

  beforeAll(async () => {
    const h1 = harness();
    const h2 = harness();
    const h3 = harness();
    dirs.push(h1.dir, h2.dir, h3.dir);
    first = await runAgainst(serverA, h1);
    second = await runAgainst(serverA, h2);
    third = await runAgainst(serverB, h3); // same bytes, different port
  }, 300_000);

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("the pack really produced a failing check and two erroring checks", () => {
    const outcomes = Object.fromEntries(first.checks.map((c) => [c.check_id, c.outcome]));
    expect(outcomes["d-passes"]).toBe("pass");
    expect(outcomes["d-fails"]).toBe("fail");
    expect(outcomes["d-errors-step"]).toBe("error");
    expect(outcomes["d-errors-predicate"]).toBe("error");
    // The check after the failures still ran: an obstacle ends that check only.
    expect(outcomes["d-passes-after-errors"]).toBe("pass");
    // And there is real machine-written text in there to go wrong.
    expect(checkById(first, "d-errors-step").error?.message).toMatch(/\d+ms/);
    expect(checkById(first, "d-errors-predicate").detail).not.toBe(checkById(first, "d-errors-step").detail);
  });

  test("the two runs are NOT the same records: ids, timestamps and durations really differ", () => {
    // If none of this differed, identical digests would prove nothing at all.
    expect(first.run_id).not.toBe(second.run_id);
    expect(first.artifacts.run_dir).not.toBe(second.artifacts.run_dir);
    expect(first.timestamp).not.toBe(second.timestamp);
    const firstStarteds = first.checks.map((c) => c.started_at);
    expect(second.checks.some((c) => !firstStarteds.includes(c.started_at))).toBe(true);
    expect(second.checks.some((c, i) => c.duration_ms !== first.checks[i].duration_ms)).toBe(true);
    // The two runs were served on different ports, and the records say so.
    expect(first.app.base_url).not.toBe(third.app.base_url);
    expect(serverA.base).not.toBe(serverB.base);
  });

  test("THE TWO OUTCOME DIGESTS ARE IDENTICAL", () => {
    expect(second.outcome_digest).toBe(first.outcome_digest);
    // ...on a run containing a failing check and an erroring check.
    expect(first.outcome_digest).toMatch(/^[0-9a-f]{64}$/);
    // Every outcome-bearing field agrees, check for check, in pack order.
    expect(second.checks.map((c) => [c.check_id, c.outcome, c.observed, c.expected, c.detail])).toEqual(
      first.checks.map((c) => [c.check_id, c.outcome, c.observed, c.expected, c.detail]),
    );
    // The digest is a function of the outcomes: recomputing it from the run's
    // own record reproduces the value the runner recorded, for both runs.
    expect(digestOutcomes(second.checks, digestScopeForRun(second))).toBe(first.outcome_digest);
    expect(digestOutcomes(first.checks, digestScopeForRun(first))).toBe(first.outcome_digest);
    expect(digestOutcomes(third.checks, digestScopeForRun(third))).toBe(first.outcome_digest);
  });

  test("a third run on a DIFFERENT PORT of the same app state agrees too", () => {
    expect(third.outcome_digest).toBe(first.outcome_digest);
    expect(third.checks.map((c) => [c.check_id, c.outcome, c.detail])).toEqual(first.checks.map((c) => [c.check_id, c.outcome, c.detail]));
  });

  test("the projection that is hashed carries no run-to-run volatile text", () => {
    const projection = JSON.stringify(digestProjection(second.checks, { baseUrl: serverA.base, artifactsDir: second.artifacts.run_dir }));
    const firstProjection = JSON.stringify(digestProjection(first.checks, { baseUrl: serverA.base, artifactsDir: first.artifacts.run_dir }));
    // The duration the driver wrote into its message is present in the record...
    expect(checkById(second, "d-errors-step").error!.message).toMatch(/\d+ms/);
    // ...and gone, replaced by a marker, in what is hashed.
    expect(projection).toContain("<duration>");
    expect(projection).not.toMatch(/\d+ms/);
    // No wall-clock timestamp, heap address or temp path survives either.
    expect(projection).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(projection).not.toMatch(/0x[0-9a-f]{4,}/);
    expect(projection).not.toMatch(/\/(?:tmp|var\/folders)\//);
    // Nor the host and port the app was served on.
    expect(projection).not.toContain(serverA.base);
    expect(projection).toContain("<origin>");
    // Which is exactly why the two projections hash to the same digest.
    expect(firstProjection).toBe(projection);
  });

  test("but the digest is still sensitive: a changed observation is a changed digest", () => {
    const one = cloneResults(first);
    const other = cloneResults(first);
    const failedIndex = other.findIndex((c) => c.check_id === "d-fails");
    // A page that renders a slightly different word must NOT look identical.
    other[failedIndex].observed = `${other[failedIndex].observed} [a different page]`;
    expect(digestOutcomes(other)).not.toBe(digestOutcomes(one));
    // Nor must a changed claim about a number.
    const numeric = cloneResults(first);
    const numericOther = cloneResults(first);
    numericOther[0].observed = "90.01 (read from [data-testid=subtotal])";
    numeric[0].observed = "90 (read from [data-testid=subtotal])";
    expect(digestOutcomes(numericOther)).not.toBe(digestOutcomes(numeric));
    // Nor a changed outcome.
    const promoted = cloneResults(first);
    promoted[failedIndex].outcome = "pass";
    expect(digestOutcomes(promoted)).not.toBe(digestOutcomes(one));
    // Nor a changed requirement binding.
    const rebound = cloneResults(first);
    rebound[0].requirement_id = "R99";
    expect(digestOutcomes(rebound)).not.toBe(digestOutcomes(one));
  });

  test("page content is evidence: a value that only LOOKS volatile is not collapsed", () => {
    // The deliberate boundary. Engine prose is normalised; the page's own text
    // is not, because two runs that saw different page text did not see the same
    // thing. This is the case the digest refuses to call a match.
    const one = cloneResults(first);
    const other = cloneResults(first);
    const idx = other.findIndex((c) => c.check_id === "d-fails");
    other[idx].observed = "visible text contains \"Free shipping\" -> not found; page text: \"updated 2026-02-03T04:05:06.000Z\"";
    expect(digestOutcomes(other)).not.toBe(digestOutcomes(one));
  });
});

describe("volatile text, class by class", () => {
  const samples: { class: string; a: string; b: string }[] = [
    {
      class: "measured durations (ms, s, spelled out)",
      a: "wait_for for selector \"[x]\" timed out after 400ms: locator.waitFor: Timeout 400ms exceeded. It took 1.20s.",
      b: "wait_for for selector \"[x]\" timed out after 400ms: locator.waitFor: Timeout 400ms exceeded. It took 1.32s.",
    },
    {
      class: "ISO-8601 timestamps",
      a: "the page was last updated 2026-02-03T04:05:06.000Z when we looked",
      b: "the page was last updated 2026-10-09T11:22:33.451Z when we looked",
    },
    {
      class: "Date.toString() timestamps",
      a: "at Mon Feb 03 2026 04:05:06 GMT+0000 (Coordinated Universal Time)",
      b: "at Fri Oct 09 2026 11:22:33 GMT+0000 (Coordinated Universal Time)",
    },
    {
      class: "temporary paths",
      a: "browser profile was /tmp/aletheia-cdp-L8Xq2p/Default, artifacts in /private/var/folders/ab/cd1234/T/x",
      b: "browser profile was /tmp/aletheia-cdp-Qq7Wza/Default, artifacts in /private/var/folders/zz/ef9876/T/y",
    },
    {
      class: "heap and object addresses",
      a: "Segmentation fault at 0x7ffd4a1b2c30 in v8::internal::Runtime_TryInstallOptimizedCode",
      b: "Segmentation fault at 0x55e9f0a1b2c0 in v8::internal::Runtime_TryInstallOptimizedCode",
    },
    {
      class: "stack-frame coordinates",
      a: "TypeError: cannot read properties of undefined\n  at applyDiscount (http://127.0.0.1:4287/app.js:42:17)",
      b: "TypeError: cannot read properties of undefined\n  at applyDiscount (http://127.0.0.1:4287/app.js:88:3)",
    },
  ];

  for (const sample of samples) {
    test(`${sample.class}: rewritten to a marker`, () => {
      const a = normalizeVolatileText(sample.a);
      const b = normalizeVolatileText(sample.b);
      expect(a).toBe(b);
      expect(a).not.toBe(sample.a);
    });
  }

  test("every declared rule rewrites something, and each says what it is for", () => {
    for (const rule of VOLATILE_TEXT_RULES) {
      expect(rule.pattern.global).toBe(true);
      expect(rule.what.length).toBeGreaterThan(10);
      expect(rule.replacement.startsWith("<") && rule.replacement.endsWith(">")).toBe(true);
    }
    expect(VOLATILE_TEXT_RULES.map((r) => r.id)).toEqual([
      "temp-path",
      "iso-timestamp",
      "date-to-string-timestamp",
      "clock-time",
      "duration",
      "heap-address",
      "stack-frame",
    ]);
    // A URL is not mangled by the stack-frame or clock-time rules.
    expect(normalizeVolatileText("read from http://127.0.0.1:4287/cart.html?t=1")).toBe("read from http://127.0.0.1:4287/cart.html?t=1");
  });

  test("explanation text that differs only in volatile tokens hashes the same", () => {
    const a = [
      {
        check_id: "c1",
        requirement_id: "R1",
        description: "d",
        outcome: "error" as const,
        observed: null,
        expected: null,
        detail: `step 2 (wait_for) could not be executed, so this check did not run to completion: wait_for for selector "[data-testid=x]" timed out after 400ms: locator.waitFor: Timeout 400ms exceeded.`,
        error: { step_index: 1, op: "wait_for", message: `wait_for for selector "[data-testid=x]" timed out after 400ms: locator.waitFor: Timeout 400ms exceeded.` },
        started_at: "2026-02-03T04:05:06.000Z",
        finished_at: "2026-02-03T04:05:06.401Z",
        duration_ms: 401,
        run_id: "run-one",
        driver: "playwright",
        selectors: {},
        actions: [],
        reads: [],
        artifacts: { dir: "checks/c1", screenshot: null, screenshots: [], trace: null, trace_format: null, trace_events: 0 },
        final_url: "http://127.0.0.1:4287/cart.html",
      },
      {
        check_id: "c1",
        requirement_id: "R1",
        description: "d",
        outcome: "error" as const,
        observed: null,
        expected: null,
        detail: `step 2 (wait_for) could not be executed, so this check did not run to completion: wait_for for selector "[data-testid=x]" timed out after 400ms: locator.waitFor: Timeout 400ms exceeded.`,
        error: { step_index: 1, op: "wait_for", message: `wait_for for selector "[data-testid=x]" timed out after 400ms: locator.waitFor: Timeout 400ms exceeded.` },
        started_at: "2026-10-09T11:22:33.000Z",
        finished_at: "2026-10-09T11:22:33.377Z",
        duration_ms: 377,
        run_id: "run-two",
        driver: "playwright",
        selectors: {},
        actions: [],
        reads: [],
        artifacts: { dir: "checks/c1", screenshot: null, screenshots: [], trace: null, trace_format: null, trace_events: 0 },
        final_url: "http://127.0.0.1:4287/cart.html",
      },
    ] as unknown as CheckResult[];
    expect(digestOutcomes([a[1]])).toBe(digestOutcomes([a[0]]));
    // Timestamps, durations and run ids are absent from the projection entirely.
    const projection = JSON.stringify(digestProjection([a[0]]));
    expect(projection).not.toContain("2026-02-03");
    expect(projection).not.toContain("401");
    expect(projection).not.toContain("run-one");
  });
});
