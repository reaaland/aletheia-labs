/**
 * Tests for the browser execution layer.
 *
 * These run a REAL browser against the tiny pages this repository authors
 * itself (fixtures/web) -- never against another team's fixture. The server
 * binds port 0 and reports the port it got, so nothing here can collide with
 * TEST-ENV`PORT`, port 3000, or any other process.
 *
 * What is proven here:
 *  - a check that passes, a check that fails, and a check whose step cannot be
 *    executed -- the last one degrades that check only, the run continues;
 *  - the coverage report, including requirements with no check at all;
 *  - determinism: the same pack and app state produce the same outcome digest;
 *  - the artifact files (screenshots and traces) really exist on disk;
 *  - one ledger entry per run, in the append-only verification chain;
 *  - both independent drivers can execute the same pack.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedger } from "../src/ledger/sqlite.ts";
import { SpecError, validatePack, verifyWebApp } from "../src/browser/index.ts";
import { digestOutcomes, digestScopeForRun } from "../src/browser/runner.ts";
import type { CheckPack, Env, VerificationRun } from "../src/browser/index.ts";

const webRoot = join(import.meta.dir, "..", "fixtures", "web");
const env = process.env as Env;

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(join(webRoot, path));
      return file.exists().then((ok) => (ok ? new Response(file, { headers: { "cache-type": "no-store" } }) : new Response("not found", { status: 404 })));
    },
  });
  base = `http://127.0.0.1:${(server as { port: number }).port}`;
});

afterAll(() => {
  server.stop(true);
});

/** The pack used by most tests: pass, fail, error, and a check after the error. */
function buildPack(): CheckPack {
  return validatePack({
    spec_version: 1,
    pack_id: "test-pack",
    pack_version: "1.0.0",
    description: "checks used by the browser layer's own tests",
    selectors: {
      subtotal: "[data-testid=subtotal]",
      lineTotalA: "[data-testid=line-total-A]",
      lineTotalB: "[data-testid=line-total-B]",
      catalogueItems: "#catalogue li.product",
      discountCode: "#discount-code",
      applyDiscount: "#apply-discount",
      net: "[data-testid=net]",
      missingThing: "[data-testid=this-does-not-exist]",
    },
    checks: [
      {
        id: "c-passes",
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
              message: "subtotal must equal the line totals added up",
            },
          },
        ],
      },
      {
        id: "c-fails",
        requirement_id: "R2",
        description: "the page offers free shipping over $50",
        steps: [
          { op: "navigate", path: "/cart.html" },
          { op: "expect", expect: { kind: "text_present", text: "Free shipping", message: "shipping must be advertised" } },
        ],
      },
      {
        id: "c-errors",
        requirement_id: "R3",
        description: "the page exposes a blocked-checkout state",
        steps: [
          { op: "navigate", path: "/cart.html" },
          { op: "wait_for", selector: "missingThing", state: "visible", timeout_ms: 300 },
        ],
      },
      {
        id: "c-after-error",
        requirement_id: "R4",
        description: "the catalogue lists products cheapest first",
        steps: [
          { op: "navigate", path: "/index.html" },
          { op: "expect", expect: { kind: "list_order", selector: "catalogueItems", mode: "ascending", item: { sub_selector: ".price", strip: "[^0-9.]" } } },
        ],
      },
      {
        id: "c-types-and-clicks",
        requirement_id: "R2",
        description: "typing a valid code and clicking apply takes 10% off",
        steps: [
          { op: "navigate", path: "/cart.html" },
          { op: "type", selector: "discountCode", text: "SAVE10" },
          { op: "click", selector: "applyDiscount" },
          { op: "wait_for_text", selector: "net", text: "$81.00" },
          { op: "expect", expect: { kind: "text_present", selector: "net", text: "$81.00", message: "the discounted subtotal must be shown" } },
        ],
      },
    ],
  });
}

const REQUIREMENTS = {
  set_id: "test-requirements",
  version: "1.0.0",
  requirements: [
    { id: "R1", text: "subtotal is the sum of the line totals" },
    { id: "R2", text: "free shipping is advertised" },
    { id: "R3", text: "blocked checkout state is exposed" },
    { id: "R4", text: "catalogue is cheapest first" },
    { id: "R5", text: "a returning customer sees past orders" },
  ],
};

interface Harness {
  dir: string;
  artifacts: string;
  dbPath: string;
  packPath: string;
  reqPath: string;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "aletheia-browser-"));
  const packPath = join(dir, "pack.json");
  const reqPath = join(dir, "requirements.json");
  writeFileSync(packPath, `${JSON.stringify(buildPack(), null, 2)}\n`, "utf8");
  writeFileSync(reqPath, `${JSON.stringify(REQUIREMENTS, null, 2)}\n`, "utf8");
  return { dir, artifacts: join(dir, "artifacts"), dbPath: join(dir, "ledger.db"), packPath, reqPath };
}

async function runPack(h: Harness, extra: Record<string, unknown> = {}) {
  return verifyWebApp({
    env,
    packPath: h.packPath,
    baseUrl: base,
    artifactsDir: h.artifacts,
    dbPath: h.dbPath,
    databaseUrl: null,
    requirementsPath: h.reqPath,
    now: () => new Date("2026-02-03T04:05:06.000Z"),
    ...extra,
  });
}

function byId(run: VerificationRun, id: string) {
  const found = run.checks.find((c) => c.check_id === id);
  if (!found) throw new Error(`no check ${id} in the run`);
  return found;
}

describe("a check pack run against a real browser", () => {
  let h: Harness;
  let firstRun: VerificationRun;

  test(
    "executes every check and records pass, fail and error without stopping",
    async () => {
      h = harness();
      const result = await runPack(h);
      firstRun = result.run;

      expect(firstRun.checks.length).toBe(5);
      expect(byId(firstRun, "c-passes").outcome).toBe("pass");
      expect(byId(firstRun, "c-fails").outcome).toBe("fail");
      expect(byId(firstRun, "c-errors").outcome).toBe("error");
      // The check that comes AFTER the one which could not be executed still ran.
      expect(byId(firstRun, "c-after-error").outcome).toBe("pass");
      expect(firstRun.checks.map((c) => c.check_id)).toEqual(["c-passes", "c-fails", "c-errors", "c-after-error", "c-types-and-clicks"]);

      // A failing check says what was seen and what was required.
      const failed = byId(firstRun, "c-fails");
      expect(failed.detail).toContain("Free shipping");
      expect(failed.observed).toContain("not found");
      expect(failed.expected).toContain("Free shipping");

      // The erroring check names the step and the op that could not execute.
      const errored = byId(firstRun, "c-errors");
      expect(errored.error?.step_index).toBe(1);
      expect(errored.error?.op).toBe("wait_for");
      expect(errored.error?.message).toContain("this-does-not-exist");
      expect(errored.detail).toContain("did not run to completion");
    },
    120_000,
  );

  test(
    "an executed check can be cited: it carries its requirement, its actions and its reads",
    () => {
      const check = byId(firstRun, "c-passes");
      expect(check.requirement_id).toBe("R1");
      expect(check.run_id).toBe(firstRun.run_id);
      expect(check.actions.map((a) => a.op)).toEqual(["navigate", "expect"]);
      expect(check.actions[0].status).toBe("ok");
      expect(check.actions[0].resolved_selector).toBeNull();
      // The recomputed value and the values it was recomputed from are all recorded.
      expect(check.expected).toContain("line_a + line_b");
      const names = check.reads.map((r) => r.name);
      expect(names).toContain("actual");
      expect(names).toContain("line_a");
      expect(names).toContain("line_b");
      expect(check.reads.find((r) => r.name === "line_a")?.value).toBe(50);
      expect(check.observed).toBe("90 (read from [data-testid=subtotal])");
      expect(check.selectors.subtotal).toBe("[data-testid=subtotal]");
    },
    60_000,
  );

  test(
    "the screenshot and the trace are real files on disk",
    () => {
      for (const check of firstRun.checks) {
        expect(check.artifacts.screenshot).not.toBeNull();
        const shot = join(firstRun.artifacts.run_dir, check.artifacts.screenshot!);
        expect(existsSync(shot)).toBe(true);
        expect(statSync(shot).size).toBeGreaterThan(1000);
        // A PNG, not an empty file with the right name.
        expect(readFileSync(shot).subarray(1, 4).toString("ascii")).toBe("PNG");

        expect(check.artifacts.trace).not.toBeNull();
        const trace = join(firstRun.artifacts.run_dir, check.artifacts.trace!);
        expect(existsSync(trace)).toBe(true);
        expect(statSync(trace).size).toBeGreaterThan(200);
      }
      const passTrace = join(firstRun.artifacts.run_dir, byId(firstRun, "c-passes").artifacts.trace!);
      expect(byId(firstRun, "c-passes").artifacts.trace_format).toBe("playwright-zip");
      expect(readFileSync(passTrace).subarray(0, 2).toString("ascii")).toBe("PK");
    },
    60_000,
  );

  test(
    "the run writes run.json, coverage.json and report.md",
    () => {
      const record = JSON.parse(readFileSync(firstRun.artifacts.run_json, "utf8")) as VerificationRun;
      expect(record.run_id).toBe(firstRun.run_id);
      expect(record.kind).toBe("verification");
      expect(record.outcome_digest).toBe(firstRun.outcome_digest);
      expect(record.checks.length).toBe(5);
      const coverage = JSON.parse(readFileSync(firstRun.artifacts.coverage_json, "utf8"));
      expect(coverage.totals.requirements).toBe(5);
      const report = readFileSync(firstRun.artifacts.report_markdown, "utf8");
      expect(report).toContain("Independent build receipt");
      expect(report).toContain("UNVERIFIED");
      expect(report).toContain(firstRun.outcome_digest);
    },
    60_000,
  );

  test(
    "coverage marks an unbound requirement UNVERIFIED and an unexecuted check never passes it",
    () => {
      const states = Object.fromEntries(firstRun.coverage.requirements.map((r) => [r.id, r.state]));
      expect(states.R1).toBe("PASSED");
      expect(states.R2).toBe("FAILED");
      expect(states.R3).toBe("ERROR");
      expect(states.R4).toBe("PASSED");
      // R5 has no check at all in the pack: never passed, stated as unverified.
      expect(states.R5).toBe("UNVERIFIED");
      expect(firstRun.coverage.unverified_requirement_ids).toEqual(["R5"]);
      expect(firstRun.coverage.requirements.find((r) => r.id === "R5")?.note).toContain("no check");
      expect(firstRun.coverage.honesty.join(" ")).toContain("R5");
      // No requirement with an unexecuted or errored check is ever PASSED.
      for (const r of firstRun.coverage.requirements) {
        if (r.executed === 0) expect(r.state).toBe("UNVERIFIED");
        if (r.state === "PASSED") expect(r.executed).toBeGreaterThan(0);
      }
      expect(firstRun.coverage.totals.unverified).toBe(1);
      expect(firstRun.coverage.totals.checks.executed).toBe(5);
    },
    60_000,
  );

  test(
    "the run appends exactly one entry to the append-only verification ledger, in its own hash chain",
    async () => {
      expect(firstRun.hash).not.toBe("");
      const ledger = new SqliteLedger(h.dbPath);
      try {
        expect(await ledger.count()).toBe(0); // nothing leaked into the research stream
        expect(await ledger.countVerifications()).toBe(1);
        const stored = await ledger.getVerification(firstRun.run_id);
        expect(stored).not.toBeNull();
        expect(stored!.hash).toBe(firstRun.hash);
        expect(stored!.coverage.totals.checks.executed).toBe(5);
        expect(stored!.checks[0].artifacts.screenshot).toBe(firstRun.checks[0].artifacts.screenshot);
        const chain = await ledger.verifyVerificationChain();
        expect(chain.ok).toBe(true);
        expect(chain.checked).toBe(1);
        // The ledger refuses to let a verification entry be edited or deleted.
        expect(() =>
          ledger.raw().query("UPDATE verification_runs SET checks_passed = 99 WHERE run_id = ?").run(firstRun.run_id),
        ).toThrow();
        expect(() => ledger.raw().query("DELETE FROM verification_runs WHERE run_id = ?").run(firstRun.run_id)).toThrow();
      } finally {
        await ledger.close();
      }
    },
    60_000,
  );

  test(
    "the same pack against the same app state is deterministic: identical outcome digest",
    async () => {
      const second = harness();
      const again = await runPack(second);
      expect(again.run.outcome_digest).toBe(firstRun.outcome_digest);
      expect(again.run.checks.map((c) => [c.check_id, c.outcome, c.observed, c.expected, c.detail])).toEqual(
        firstRun.checks.map((c) => [c.check_id, c.outcome, c.observed, c.expected, c.detail]),
      );
      // The digest is a function of the outcomes only, not of ids, timestamps,
      // measured durations or the port the app was served on: recomputing it from
      // the run's own record reproduces the value the runner recorded.
      expect(digestOutcomes(again.run.checks, digestScopeForRun(again.run))).toBe(firstRun.outcome_digest);
      expect(digestOutcomes(firstRun.checks, digestScopeForRun(firstRun))).toBe(firstRun.outcome_digest);
      rmSync(second.dir, { recursive: true, force: true });
    },
    120_000,
  );
});

describe("coverage honesty under filtering", () => {
  test(
    "a check filtered out leaves its requirement UNVERIFIED, never passed",
    async () => {
      const h = harness();
      const result = await runPack(h, { only: ["c-passes"] });
      expect(result.run.checks.length).toBe(1);
      const states = Object.fromEntries(result.run.coverage.requirements.map((r) => [r.id, r.state]));
      expect(states.R1).toBe("PASSED");
      expect(states.R2).toBe("UNVERIFIED");
      expect(states.R3).toBe("UNVERIFIED");
      expect(states.R4).toBe("UNVERIFIED");
      expect(states.R5).toBe("UNVERIFIED");
      expect(result.run.coverage.requirements.find((r) => r.id === "R2")?.note).toContain("filtered out");
      expect(result.run.coverage.honesty.join(" ")).toContain("not executed in this run");
      rmSync(h.dir, { recursive: true, force: true });
    },
    120_000,
  );
});

describe("the two drivers are independently sufficient", () => {
  test(
    "the CDP driver (no third-party dependency) executes the same pack",
    async () => {
      const h = harness();
      const result = await runPack(h, { only: ["c-passes", "c-fails", "c-types-and-clicks"], driver: "cdp" });
      expect(result.run.driver.id).toBe("cdp");
      expect(byId(result.run, "c-passes").outcome).toBe("pass");
      expect(byId(result.run, "c-types-and-clicks").outcome).toBe("pass");
      expect(byId(result.run, "c-fails").outcome).toBe("fail");
      const trace = byId(result.run, "c-types-and-clicks").artifacts;
      expect(trace.trace_format).toBe("cdp-session-log");
      const text = readFileSync(join(result.run.artifacts.run_dir, trace.trace!), "utf8");
      expect(text).toContain("dom_element_click");
      expect(text).toContain("dom_value_set");
      expect(text).toContain("trace.start");
      // The run says, in its own notes, how the CDP driver acted on the page.
      expect(result.run.notes.join(" ")).toContain("scripted DOM calls");
      rmSync(h.dir, { recursive: true, force: true });
    },
    120_000,
  );
});

describe("a malformed pack is refused, not guessed at", () => {
  test("a check with no requirement id is rejected", () => {
    expect(() =>
      validatePack({
        spec_version: 1,
        pack_id: "bad",
        pack_version: "1.0.0",
        checks: [{ id: "c1", description: "no requirement", steps: [{ op: "navigate", path: "/" }] }],
      }),
    ).toThrow(/requirement_id/);
  });

  test("an undeclared selector name that is not CSS is rejected as a likely typo", () => {
    let error: unknown = null;
    try {
      validatePack({
        spec_version: 1,
        pack_id: "bad",
        pack_version: "1.0.0",
        selectors: { known: "#known" },
        checks: [
          {
            id: "c1",
            requirement_id: "R1",
            description: "typo",
            steps: [{ op: "click", selector: "unknownOne" }],
          },
        ],
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SpecError);
    expect((error as SpecError).problems.join(" ")).toContain("unknownOne");
  });

  test("an unknown spec version is rejected", () => {
    expect(() => validatePack({ spec_version: 99, pack_id: "x", pack_version: "1", checks: [] })).toThrow(/spec_version/);
  });

  test("a broken formula is caught when the pack loads, not mid-run", () => {
    expect(() =>
      validatePack({
        spec_version: 1,
        pack_id: "bad",
        pack_version: "1.0.0",
        selectors: { a: "#a" },
        checks: [
          {
            id: "c1",
            requirement_id: "R1",
            description: "broken formula",
            steps: [{ op: "expect", expect: { kind: "value_equals", actual: { selector: "a", as: "number" }, expected: { expr: "1 +" } } }],
          },
        ],
      }),
    ).toThrow(/expr/);
  });
});
