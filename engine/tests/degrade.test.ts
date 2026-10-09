import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AdapterOutcome, Env, FailureCode, RetrievalAdapter, RetrievalRequest } from "../src/types.ts";
import { runResearch } from "../src/pipeline.ts";
import { loadConfig } from "../src/config.ts";
import { SqliteLedger } from "../src/ledger/sqlite.ts";
import { buildDissent } from "../src/reasoning/heuristic.ts";
import { fixtures, QUESTION, RUN_DATE } from "../fixtures/sources.ts";

const RUBRIC = resolve(import.meta.dir, "..", "rubric", "v1.json");

function stubAdapter(
  id: string,
  behaviour: "throws" | "rate_limited" | "timeout" | "empty" | "healthy",
  docs = fixtures.slice(0, 2),
): RetrievalAdapter {
  return {
    layer: "retrieval",
    id,
    label: `stub ${id}`,
    description: "test double",
    configKeys: [],
    available: () => true,
    async retrieve(req: RetrievalRequest): Promise<AdapterOutcome> {
      void req;
      if (behaviour === "throws") throw new Error("boom: provider exploded");
      if (behaviour === "rate_limited") {
        return {
          adapter: id,
          label: `stub ${id}`,
          layer: "retrieval",
          status: "failed",
          reason: "HTTP 429 Too Many Requests",
          reasonCode: "rate_limited",
          requiredConfig: [],
          docs: [],
          durationMs: 1,
          detail: null,
        };
      }
      if (behaviour === "timeout") {
        return {
          adapter: id,
          label: `stub ${id}`,
          layer: "retrieval",
          status: "failed",
          reason: "the operation was aborted",
          reasonCode: "timeout",
          requiredConfig: [],
          docs: [],
          durationMs: 1,
          detail: null,
        };
      }
      if (behaviour === "empty") {
        return {
          adapter: id,
          label: `stub ${id}`,
          layer: "retrieval",
          status: "unavailable",
          reason: "adapter ran but produced no usable sources",
          reasonCode: "empty_result",
          requiredConfig: [],
          docs: [],
          durationMs: 1,
          detail: null,
        };
      }
      return {
        adapter: id,
        label: `stub ${id}`,
        layer: "retrieval",
        status: "ok",
        reason: null,
        reasonCode: null,
        requiredConfig: [],
        docs,
        durationMs: 1,
        detail: null,
      };
    },
  };
}

function keyGatedAdapter(id: string, key: string): RetrievalAdapter {
  return {
    layer: "retrieval",
    id,
    label: `gated ${id}`,
    description: "requires a credential",
    configKeys: [key],
    available: (env: Env) => Boolean(env[key]),
    async retrieve(): Promise<AdapterOutcome> {
      throw new Error("should never be called without a key");
    },
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "aletheia-degrade-"));
}

describe("a broken retrieval provider degrades the run, never kills it", () => {
  test("an adapter that throws is recorded as failed and the run still produces a cited verdict", async () => {
    const dir = tempDir();
    const config = loadConfig({}, { dbPath: join(dir, "l.db"), rubricPath: RUBRIC, offline: false, ledgerEnabled: false });
    try {
      const result = await runResearch({
        question: QUESTION,
        urls: [],
        config,
        adapters: [stubAdapter("explodes", "throws"), stubAdapter("works", "healthy")],
        runDate: RUN_DATE,
        skipLedger: true,
      });
      const failed = result.outcomes.find((o) => o.adapter === "explodes");
      expect(failed?.status).toBe("failed");
      expect(failed?.reason).toMatch(/adapter threw/);
      expect(result.entry.sources.length).toBeGreaterThan(0);
      expect(result.entry.verdict.text.length).toBeGreaterThan(0);
      expect(result.entry.verdict.confidence.score).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rate-limited adapter degrades and its reason is visible in the report", async () => {
    const dir = tempDir();
    const config = loadConfig({}, { dbPath: join(dir, "l.db"), rubricPath: RUBRIC, ledgerEnabled: false });
    try {
      const result = await runResearch({
        question: QUESTION,
        urls: [],
        config,
        adapters: [stubAdapter("limited", "rate_limited"), stubAdapter("works", "healthy")],
        runDate: RUN_DATE,
        skipLedger: true,
      });
      const limited = result.outcomes.find((o) => o.adapter === "limited");
      expect(limited?.status).toBe("failed");
      expect(limited?.reasonCode).toBe("rate_limited");
      expect(result.markdown).toContain("limited");
      expect(result.markdown).toMatch(/rate_limited/);
      expect(result.entry.retrieval.find((r) => r.adapter === "limited")?.reason).toMatch(/429/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every adapter failing still yields a report that says so instead of crashing", async () => {
    const dir = tempDir();
    const config = loadConfig({}, { dbPath: join(dir, "l.db"), rubricPath: RUBRIC, ledgerEnabled: false });
    try {
      const result = await runResearch({
        question: QUESTION,
        urls: [],
        config,
        adapters: [stubAdapter("a", "throws"), stubAdapter("b", "rate_limited"), stubAdapter("c", "timeout"), stubAdapter("d", "empty")],
        runDate: RUN_DATE,
        skipLedger: true,
      });
      expect(result.entry.sources).toHaveLength(0);
      expect(result.entry.verdict.confidence.level).toBe("very_low");
      expect(result.markdown).toMatch(/No source was retrieved/);
      const kinds = result.entry.verdict.dissent.filter((d) => d.kind === "unavailable_provider");
      expect(kinds.length).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("degradation lowers confidence via the recorded retrieval factor", async () => {
    const dir = tempDir();
    const config = loadConfig({}, { dbPath: join(dir, "l.db"), rubricPath: RUBRIC, ledgerEnabled: false });
    try {
      const healthy = await runResearch({
        question: QUESTION,
        urls: [],
        config,
        adapters: [stubAdapter("a", "healthy"), stubAdapter("b", "healthy")],
        runDate: RUN_DATE,
        skipLedger: true,
      });
      const degraded = await runResearch({
        question: QUESTION,
        urls: [],
        config,
        adapters: [stubAdapter("a", "healthy"), stubAdapter("b", "rate_limited"), stubAdapter("c", "throws")],
        runDate: RUN_DATE,
        skipLedger: true,
      });
      expect(degraded.entry.verdict.confidence.inputs.retrievalFactor).toBeLessThan(
        healthy.entry.verdict.confidence.inputs.retrievalFactor,
      );
      expect(degraded.entry.verdict.confidence.inputs.adaptersAvailable).toBeLessThan(
        degraded.entry.verdict.confidence.inputs.adaptersTotal,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removing every provider-specific credential changes nothing about whether the run completes", async () => {
    const dir = tempDir();
    // An environment with no keys at all, including a credentialled adapter.
    const env: Env = {};
    const config = loadConfig(env, { dbPath: join(dir, "l.db"), rubricPath: RUBRIC, ledgerEnabled: false });
    try {
      const result = await runResearch({
        question: QUESTION,
        urls: [],
        config,
        adapters: [keyGatedAdapter("paid-provider", "SOME_PAID_API_KEY"), stubAdapter("keyless", "healthy")],
        runDate: RUN_DATE,
        skipLedger: true,
      });
      const gated = result.outcomes.find((o) => o.adapter === "paid-provider");
      expect(gated?.status).toBe("unavailable");
      expect(gated?.reasonCode).toBe("unconfigured");
      expect(result.entry.sources.length).toBeGreaterThan(0);
      // A missing credential is listed as a gap, not a fatal error.
      expect(buildDissent({
        question: QUESTION,
        groups: [],
        clusters: [],
        claims: [],
        sources: [],
        conflicts: [],
        confidence: { level: "very_low", score: 0, bandMin: 0, inputs: {} as never, formula: "", explanation: "" },
        outcomes: result.outcomes,
        rubric: { reporting: { citationStyle: "[S<n>]", maxClaimsPerGroup: 6, maxSourcesShown: 24 } } as never,
        env,
      }).some((d) => /paid-provider/.test(d.summary))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("offline mode is a clean, honest failure mode", () => {
  test("the pipeline completes with every network path disabled and says why", async () => {
    const dir = tempDir();
    const config = loadConfig({ ALETHEIA_OFFLINE: "1" }, { dbPath: join(dir, "l.db"), rubricPath: RUBRIC });
    try {
      const result = await runResearch({ question: QUESTION, urls: [], config, runDate: RUN_DATE, skipLedger: true });
      for (const o of result.outcomes) {
        expect(o.status).toBe("unavailable");
        expect(o.reasonCode).toBe("disabled");
        expect(o.reason).toMatch(/offline mode/);
      }
      expect(result.markdown).toMatch(/offline mode/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("credential-free end to end", () => {
  test("with an empty environment and only key-free code paths, the run completes and appends to the ledger", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "l.db");
    const config = loadConfig({}, { dbPath, rubricPath: RUBRIC });
    const ledger = new SqliteLedger(dbPath);
    try {
      const result = await runResearch({
        question: QUESTION,
        urls: [],
        config,
        adapters: [stubAdapter("keyless-a", "healthy"), stubAdapter("keyless-b", "healthy", fixtures.slice(2))],
        runDate: RUN_DATE,
        ledger,
      });
      expect(result.ledgerBackend).toBe("sqlite");
      expect(result.ledgerError).toBeNull();
      const stored = await ledger.get(result.entry.runId);
      expect(stored?.question).toBe(QUESTION);
      expect((await ledger.verifyChain()).ok).toBe(true);
      expect(result.markdown).toContain("**Question.**" === "" ? "" : result.entry.question);
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same question at the same recorded time produces the same run id and the same scores", async () => {
    const dir = tempDir();
    const config = loadConfig({}, { dbPath: join(dir, "l.db"), rubricPath: RUBRIC, ledgerEnabled: false });
    try {
      const first = await runResearch({ question: QUESTION, urls: [], config, adapters: [stubAdapter("a", "healthy")], runDate: RUN_DATE, skipLedger: true });
      const second = await runResearch({ question: QUESTION, urls: [], config, adapters: [stubAdapter("a", "healthy")], runDate: RUN_DATE, skipLedger: true });
      expect(second.entry.runId).toBe(first.entry.runId);
      expect(JSON.stringify(second.entry.scores)).toBe(JSON.stringify(first.entry.scores));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("failure codes stay classified", () => {
  test("each stub reports the failure code the pipeline expects", async () => {
    const codes: FailureCode[] = ["rate_limited", "timeout", "empty_result"];
    const dir = tempDir();
    const config = loadConfig({}, { dbPath: join(dir, "l.db"), rubricPath: RUBRIC, ledgerEnabled: false });
    try {
      const result = await runResearch({
        question: QUESTION,
        urls: [],
        config,
        adapters: [stubAdapter("x", "rate_limited"), stubAdapter("y", "timeout"), stubAdapter("z", "empty")],
        runDate: RUN_DATE,
        skipLedger: true,
      });
      for (const code of codes) {
        expect(result.outcomes.some((o) => o.reasonCode === code)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
