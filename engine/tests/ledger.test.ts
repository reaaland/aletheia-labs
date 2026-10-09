import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedger } from "../src/ledger/sqlite.ts";
import { openLedger } from "../src/ledger/index.ts";
import { ENGINE_VERSION, canonicalJson, hashHex } from "../src/util/ids.ts";
import type { LedgerEntry } from "../src/types.ts";
import { fixtures, QUESTION } from "../fixtures/sources.ts";
import { loadRubric, rubricDigest } from "../src/grade/rubric.ts";
import { resolve } from "node:path";

const rubric = loadRubric(resolve(import.meta.dir, "..", "rubric", "v1.json"));

function entry(runId: string, question: string, confidenceScore = 0.5): LedgerEntry {
  return {
    runId,
    timestamp: "2026-01-02T00:00:00.000Z",
    engineVersion: ENGINE_VERSION,
    question,
    keywords: ["punycode"],
    rubric: { id: rubric.id, version: rubric.version, sha256: rubricDigest(rubric) },
    retrieval: [],
    sources: [],
    claims: [],
    clusters: [],
    scores: [],
    conflicts: [],
    verdict: {
      answerSummary: "summary",
      text: "verdict text",
      confidence: {
        level: "moderate",
        score: confidenceScore,
        bandMin: 0.6,
        inputs: {} as never,
        formula: "x",
        explanation: "y",
      },
      dissent: [],
      reasoningAdapter: "heuristic",
      reasoningMode: "deterministic_template",
      caveats: [],
    },
    providerConfig: {},
    notes: [],
    prevHash: null,
    hash: "",
  };
}

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "aletheia-ledger-"));
  return { dir, path: join(dir, "ledger.db") };
}

describe("the ledger is append-only", () => {
  test("entries can be appended and read back verbatim", async () => {
    const { dir, path } = tempDb();
    const ledger = new SqliteLedger(path);
    try {
      await ledger.append(entry("run-1", "first question"));
      await ledger.append(entry("run-2", "second question"));
      const got = await ledger.get("run-1");
      expect(got?.question).toBe("first question");
      expect(await ledger.count()).toBe(2);
      const list = await ledger.list(10);
      expect(list.length).toBe(2);
      // newest first
      expect(list[0].runId).toBe("run-2");
      expect(list[0].hash).toHaveLength(64);
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the ledger interface exposes no way to update or delete", () => {
    const ledger = new SqliteLedger(":memory:");
    const surface = new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(ledger)),
      ...Object.keys(ledger),
    ]);
    for (const forbidden of ["update", "delete", "remove", "set", "put", "overwrite", "edit", "truncate", "clear"]) {
      expect(surface.has(forbidden)).toBe(false);
    }
    expect(typeof (ledger as unknown as Record<string, unknown>).append).toBe("function");
    void ledger.close();
  });

  test("the database itself refuses UPDATE", async () => {
    const { dir, path } = tempDb();
    const ledger = new SqliteLedger(path);
    try {
      await ledger.append(entry("run-1", "q"));
      expect(() => ledger.raw().exec("UPDATE ledger_entries SET question = 'tampered' WHERE run_id = 'run-1'")).toThrow(
        /append-only/,
      );
      expect((await ledger.get("run-1"))?.question).toBe("q");
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the database itself refuses DELETE", async () => {
    const { dir, path } = tempDb();
    const ledger = new SqliteLedger(path);
    try {
      await ledger.append(entry("run-1", "q"));
      expect(() => ledger.raw().exec("DELETE FROM ledger_entries")).toThrow(/append-only/);
      expect(await ledger.count()).toBe(1);
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a correction is a new entry, not an edit", async () => {
    const { dir, path } = tempDb();
    const ledger = new SqliteLedger(path);
    try {
      await ledger.append(entry("run-1", "is X deprecated?"));
      const correction = entry("run-2", "is X deprecated?");
      (correction as LedgerEntry & { supersedes?: string }).supersedes = "run-1";
      await ledger.append(correction);
      expect(await ledger.count()).toBe(2);
      expect((await ledger.get("run-1"))?.verdict.text).toBe("verdict text");
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the hash chain proves the log was not rewritten", () => {
  test("an untouched ledger verifies", async () => {
    const { dir, path } = tempDb();
    const ledger = new SqliteLedger(path);
    try {
      await ledger.append(entry("run-1", "a"));
      await ledger.append(entry("run-2", "b"));
      const result = await ledger.verifyChain();
      expect(result.ok).toBe(true);
      expect(result.checked).toBe(2);
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each entry chains to the one before it", async () => {
    const { dir, path } = tempDb();
    const ledger = new SqliteLedger(path);
    try {
      await ledger.append(entry("run-1", "a"));
      await ledger.append(entry("run-2", "b"));
      const first = await ledger.get("run-1");
      const second = await ledger.get("run-2");
      expect(second?.prevHash).toBe(first?.hash);
      // The hash covers the body WITHOUT `hash` but WITH `prevHash`, so a reader
      // can recompute it with sha256sum over the canonical JSON.
      const body: Record<string, unknown> = { ...(second as LedgerEntry) };
      delete body.hash;
      expect(hashHex(`${first?.hash}${canonicalJson(body)}`)).toBe(second?.hash);
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tampered body is detected by verification", async () => {
    const { dir, path } = tempDb();
    const ledger = new SqliteLedger(path);
    try {
      await ledger.append(entry("run-1", "a"));
      // Bypass the triggers the way a determined attacker with file access would.
      ledger.raw().exec("DROP TRIGGER ledger_entries_append_only_update");
      const stored = await ledger.get("run-1");
      const tampered = { ...(stored as LedgerEntry), question: "a completely different question" };
      ledger.raw()
        .query("UPDATE ledger_entries SET body = ?, question = ? WHERE run_id = 'run-1'")
        .run(JSON.stringify(tampered), tampered.question);
      const result = await ledger.verifyChain();
      expect(result.ok).toBe(false);
      expect(result.brokenAtRunId).toBe("run-1");
      expect(result.reason).toMatch(/hash/);
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("another append after tampering still fails verification", async () => {
    const { dir, path } = tempDb();
    const ledger = new SqliteLedger(path);
    try {
      await ledger.append(entry("run-1", "a"));
      ledger.raw().exec("DROP TRIGGER ledger_entries_append_only_update");
      ledger.raw().query("UPDATE ledger_entries SET prev_hash = 'forged' WHERE run_id = 'run-1'").run();
      await ledger.append(entry("run-2", "b"));
      const result = await ledger.verifyChain();
      expect(result.ok).toBe(false);
      expect(result.brokenAtSeq).toBe(1);
    } finally {
      await ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ledger backend selection", () => {
  test("SQLite is the default and needs no DATABASE_URL", async () => {
    const { dir, path } = tempDb();
    const opened = await openLedger({ dbPath: path, databaseUrl: null });
    try {
      expect(opened.ledger.backend).toBe("sqlite");
      expect(opened.notes).toEqual([]);
      await opened.ledger.append(entry("run-1", "q"));
      expect(await opened.ledger.count()).toBe(1);
    } finally {
      await opened.ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreachable DATABASE_URL degrades to the SQLite file instead of failing the run", async () => {
    const { dir, path } = tempDb();
    const opened = await openLedger({ dbPath: path, databaseUrl: "postgres://nobody@127.0.0.1:1/none" });
    try {
      expect(opened.ledger.backend).toBe("sqlite");
      expect(opened.notes.join(" ")).toMatch(/falling back to the SQLite file/);
      await opened.ledger.append(entry("run-1", "q"));
      expect(await opened.ledger.count()).toBe(1);
    } finally {
      await opened.ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a secret in DATABASE_URL is never echoed back", async () => {
    const { dir, path } = tempDb();
    const opened = await openLedger({ dbPath: path, databaseUrl: "postgres://user:hunter2@127.0.0.1:1/db" });
    try {
      expect(opened.notes.join(" ")).not.toContain("hunter2");
    } finally {
      await opened.ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void fixtures;
void QUESTION;
