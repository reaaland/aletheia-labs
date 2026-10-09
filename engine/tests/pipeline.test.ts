import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runResearch } from "../src/pipeline.ts";
import { loadConfig } from "../src/config.ts";
import { SqliteLedger } from "../src/ledger/sqlite.ts";
import { directUrlAdapter } from "../src/retrieval/direct-url.ts";
import { allReasoningAdapters, selectReasoningAdapter } from "../src/reasoning/index.ts";

const RUBRIC = resolve(import.meta.dir, "..", "rubric", "v1.json");

/**
 * A hermetic end-to-end run: a local HTTP server stands in for the live web, so
 * the whole pipeline (direct fetch -> extract -> cluster -> score -> conflict ->
 * confidence -> verdict -> ledger) is exercised without touching the internet
 * and without a single credential.
 */
const PAGES: Record<string, { contentType: string; body: string }> = {
  "/docs": {
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><title>Deprecated APIs</title></head><body>
      <h1>Deprecated APIs</h1>
      <p>DEP0040: <code>node:punycode</code> module. The punycode module is deprecated. Please use a userland alternative instead.</p>
      <p>This deprecation is documentation-only and applies since Node.js v21.0.0.</p>
      </body></html>`,
  },
  "/registry": {
    contentType: "application/json",
    body: JSON.stringify({ name: "punycode", latest: "2.3.1", deprecated: null }),
  },
  "/blog": {
    contentType: "text/html",
    body: `<!doctype html><html><head><title>punycode is not deprecated</title></head><body>
      <p>The punycode module is not deprecated for practical purposes and no migration is required.</p>
      </body></html>`,
  },
  "/broken": { contentType: "text/html", body: "nope" },
};

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const page = PAGES[path];
      if (!page) return new Response("not found", { status: 404 });
      if (path === "/broken") return new Response("server error", { status: 500 });
      return new Response(page.body, { status: 200, headers: { "content-type": page.contentType } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("end-to-end with zero credentials, over a real HTTP stack", () => {
  test("runs the whole pipeline offline-of-the-internet and produces a cited verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aletheia-e2e-"));
    const dbPath = join(dir, "ledger.db");
    const config = loadConfig({}, { dbPath, rubricPath: RUBRIC });
    const ledger = new SqliteLedger(dbPath);
    try {
      const result = await runResearch({
        question: "Is the punycode module deprecated in Node.js and what replaces it?",
        urls: [`${base}/docs`, `${base}/registry`, `${base}/blog`, `${base}/nope`],
        config,
        adapters: [directUrlAdapter],
        runDate: "2026-01-02T00:00:00.000Z",
        ledger,
      });

      // Retrieval: three of four URLs answered, one 404 degraded the path.
      const outcome = result.outcomes[0];
      expect(outcome.adapter).toBe("direct-url");
      expect(outcome.status).toBe("partial");
      expect(outcome.reasonCode).toBe("http_error");
      expect(outcome.docs.length).toBe(3);
      expect(result.entry.sources.map((s) => s.url)).toEqual([
        `${base}/docs`,
        `${base}/registry`,
        `${base}/blog`,
      ]);

      // Claims were extracted and every one is traceable to a source.
      expect(result.entry.claims.length).toBeGreaterThan(0);
      for (const claim of result.entry.claims) {
        expect(result.entry.sources.some((s) => s.id === claim.sourceId)).toBe(true);
      }

      // Scoring: complete, rubric-versioned, with raw inputs.
      expect(result.entry.scores.length).toBe(result.entry.claims.length);
      for (const score of result.entry.scores) {
        expect(score.rubricVersion).toBe("1.0.0");
        expect(score.dimensions.map((d) => d.dimension).sort()).toEqual([
          "corroboration",
          "recency",
          "sourceClass",
          "specificity",
        ]);
      }

      // A verdict, a confidence level, and citations in the report.
      expect(result.entry.verdict.text.length).toBeGreaterThan(0);
      expect(["high", "moderate", "low", "very_low"]).toContain(result.entry.verdict.confidence.level);
      expect(result.markdown).toContain("## Verdict");
      expect(result.markdown).toContain("## Confidence");
      expect(result.markdown).toContain("## Sources");

      // The deterministic reasoner was used: no model, no key.
      expect(result.entry.verdict.reasoningAdapter).toBe("heuristic");
      expect(result.entry.verdict.reasoningMode).toBe("deterministic_template");

      // Ledger: appended, hash-chained, verifiable.
      expect(result.ledgerBackend).toBe("sqlite");
      expect((await ledger.verifyChain()).ok).toBe(true);
      expect(await ledger.count()).toBe(1);
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a contradiction on the page pair is detected and reported as dissent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aletheia-e2e2-"));
    const config = loadConfig({}, { dbPath: join(dir, "ledger.db"), rubricPath: RUBRIC, ledgerEnabled: false });
    try {
      const result = await runResearch({
        question: "Is the punycode module deprecated in Node.js and what replaces it?",
        urls: [`http://127.0.0.1:${server.port}/docs`, `http://localhost:${server.port}/blog`],
        config,
        adapters: [directUrlAdapter],
        runDate: "2026-01-02T00:00:00.000Z",
        skipLedger: true,
      });
      const polarity = result.entry.conflicts.filter((c) => c.kind === "polarity");
      expect(polarity.length).toBeGreaterThan(0);
      expect(polarity[0].resolution).toBe("not_averaged");
      expect(result.markdown).toContain("Conflicts (surfaced, never averaged)");
      const dissent = result.entry.verdict.dissent.filter((d) => d.kind === "conflict");
      expect(dissent.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("JSON output is machine-readable and mirrors the Markdown report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aletheia-e2e3-"));
    const config = loadConfig({}, { dbPath: join(dir, "ledger.db"), rubricPath: RUBRIC, ledgerEnabled: false });
    try {
      const result = await runResearch({
        question: "Is the punycode module deprecated?",
        urls: [`${base}/docs`],
        config,
        adapters: [directUrlAdapter],
        runDate: "2026-01-02T00:00:00.000Z",
        skipLedger: true,
      });
      const json = result.json as Record<string, unknown>;
      expect(json.schema).toBe("aletheia.report/1");
      expect(json.runId).toBe(result.entry.runId);
      expect(json.reportMarkdown).toBe(result.markdown);
      expect(Array.isArray(json.scores)).toBe(true);
      expect(JSON.stringify(json)).not.toMatch(/undefined/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the reasoning layer is deterministic and has exactly one implementation", () => {
  test("the registry offers one reasoner: deterministic, credential-free, always available", () => {
    const all = allReasoningAdapters();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe("heuristic");
    expect(all[0].deterministic).toBe(true);
    expect(all[0].configKeys).toEqual([]);
    expect(all[0].available({})).toBe(true);
    // An unknown id resolves to the one reasoner rather than throwing.
    expect(selectReasoningAdapter("does-not-exist").id).toBe("heuristic");
  });

  test("no file under src/ can reach a model: the whole tree is scanned", async () => {
    const root = resolve(import.meta.dir, "..", "src");
    // Provider names and model-plumbing identifiers that must not exist anywhere
    // in the engine. If someone re-adds a model path, this test fails.
    const forbidden = /LLM_|http-llm|cli-llm|model_drafted|openai|anthropic|ollama|searxng|chat\/completions|huggingface/i;
    const offenders: string[] = [];
    for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: root })) {
      const text = await Bun.file(join(root, rel)).text();
      if (forbidden.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the verdict prose is byte-identical for identical evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aletheia-reason-"));
    const config = loadConfig({}, { dbPath: join(dir, "l.db"), rubricPath: RUBRIC, ledgerEnabled: false });
    try {
      const opts = {
        question: "Is the punycode module deprecated?",
        urls: [`${base}/docs`],
        config,
        adapters: [directUrlAdapter],
        runDate: "2026-01-02T00:00:00.000Z",
        skipLedger: true,
      };
      const first = await runResearch(opts);
      const second = await runResearch(opts);
      expect(second.entry.verdict.text).toBe(first.entry.verdict.text);
      expect(second.entry.verdict.confidence.score).toBe(first.entry.verdict.confidence.score);
      expect(second.entry.verdict.reasoningAdapter).toBe("heuristic");
      expect(second.entry.verdict.reasoningMode).toBe("deterministic_template");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
