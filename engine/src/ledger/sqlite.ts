import { Database } from "bun:sqlite";
import type { LedgerEntry } from "../types.ts";
import type { VerificationRun, VerificationSummary } from "../browser/types.ts";
import { canonicalJson, hashHex, nowIso } from "../util/ids.ts";
import type { Ledger, LedgerSummary, VerifyResult } from "./types.ts";

/**
 * SQLite ledger. Append-only in three independent ways:
 *
 *  1. This class exposes no update or delete method, at all.
 *  2. SQLite triggers reject UPDATE and DELETE on the entry table, so even a
 *     hand-written statement from a sqlite3 shell fails.
 *  3. Every entry carries sha256(prevHash + canonical body), chained to the
 *     previous entry, so an edit made by any other means is detectable.
 *
 * Corrections are new entries: append a superscript entry that points at the
 * run it corrects. Nothing is ever rewritten.
 */
export class SqliteLedger implements Ledger {
  readonly backend = "sqlite" as const;
  readonly location: string;
  private db: Database;
  private closed = false;

  constructor(path: string) {
    this.location = path;
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_entries (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT    NOT NULL UNIQUE,
        recorded_at TEXT    NOT NULL,
        question    TEXT    NOT NULL,
        rubric_id   TEXT    NOT NULL,
        rubric_ver  TEXT    NOT NULL,
        confidence  TEXT    NOT NULL,
        confidence_score REAL NOT NULL,
        engine_ver  TEXT    NOT NULL,
        supersedes  TEXT,
        prev_hash   TEXT    NOT NULL,
        entry_hash  TEXT    NOT NULL,
        body        TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_question ON ledger_entries(question);
      CREATE INDEX IF NOT EXISTS idx_ledger_recorded ON ledger_entries(recorded_at);

      CREATE TABLE IF NOT EXISTS ledger_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS ledger_entries_append_only_update
      BEFORE UPDATE ON ledger_entries
      BEGIN
        SELECT RAISE(ABORT, 'ledger is append-only: entries cannot be modified (append a correction instead)');
      END;

      CREATE TRIGGER IF NOT EXISTS ledger_entries_append_only_delete
      BEFORE DELETE ON ledger_entries
      BEGIN
        SELECT RAISE(ABORT, 'ledger is append-only: entries cannot be deleted');
      END;

      -- Browser verification runs: a second append-only stream in the same
      -- ledger file, with its own hash chain. A verification run records
      -- executed checks and artifact paths, which is not the shape of a graded
      -- research answer; forcing it into one row shape would put a false value
      -- in a column. Covered by the same "no update, no delete" guarantees.
      CREATE TABLE IF NOT EXISTS verification_runs (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          TEXT    NOT NULL UNIQUE,
        recorded_at     TEXT    NOT NULL,
        pack_id         TEXT    NOT NULL,
        pack_ver        TEXT    NOT NULL,
        spec_ver        INTEGER NOT NULL,
        base_url        TEXT    NOT NULL,
        driver          TEXT    NOT NULL,
        checks_total    INTEGER NOT NULL,
        checks_passed   INTEGER NOT NULL,
        checks_failed   INTEGER NOT NULL,
        checks_errored  INTEGER NOT NULL,
        req_total       INTEGER NOT NULL,
        req_unverified  INTEGER NOT NULL,
        outcome_digest  TEXT    NOT NULL,
        prev_hash       TEXT    NOT NULL,
        entry_hash      TEXT    NOT NULL,
        body            TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_verification_pack ON verification_runs(pack_id);
      CREATE INDEX IF NOT EXISTS idx_verification_recorded ON verification_runs(recorded_at);

      CREATE TRIGGER IF NOT EXISTS verification_runs_append_only_update
      BEFORE UPDATE ON verification_runs
      BEGIN
        SELECT RAISE(ABORT, 'ledger is append-only: verification entries cannot be modified (re-run and append instead)');
      END;

      CREATE TRIGGER IF NOT EXISTS verification_runs_append_only_delete
      BEFORE DELETE ON verification_runs
      BEGIN
        SELECT RAISE(ABORT, 'ledger is append-only: verification entries cannot be deleted');
      END;
    `);
    const genesis = this.db.query("SELECT value FROM ledger_meta WHERE key = 'genesis'").get() as { value: string } | null;
    if (!genesis) {
      this.db
        .query("INSERT INTO ledger_meta (key, value) VALUES ('genesis', ?)")
        .run(`${nowIso()}|${hashHex("aletheia-genesis")}`);
    }
  }

  async append(entry: LedgerEntry): Promise<void> {
    if (this.closed) throw new Error("ledger is closed");
    const prev = this.lastHash();
    const body = { ...entry, prevHash: prev, hash: "" } as LedgerEntry;
    delete (body as unknown as Record<string, unknown>).hash;
    const entryHash = hashHex(`${prev}${canonicalJson(body)}`);
    const full: LedgerEntry = { ...(body as LedgerEntry), hash: entryHash };

    this.db
      .query(
        `INSERT INTO ledger_entries
          (run_id, recorded_at, question, rubric_id, rubric_ver, confidence, confidence_score, engine_ver, supersedes, prev_hash, entry_hash, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.runId,
        full.timestamp,
        full.question,
        full.rubric.id,
        full.rubric.version,
        full.verdict.confidence.level,
        full.verdict.confidence.score,
        full.engineVersion,
        (full as unknown as { supersedes?: string }).supersedes ?? null,
        prev,
        entryHash,
        JSON.stringify(full),
      );
  }

  private lastHash(): string {
    const row = this.db.query("SELECT entry_hash FROM ledger_entries ORDER BY seq DESC LIMIT 1").get() as { entry_hash: string } | null;
    return row?.entry_hash ?? "GENESIS";
  }

  async get(runId: string): Promise<LedgerEntry | null> {
    const row = this.db.query("SELECT body FROM ledger_entries WHERE run_id = ?").get(runId) as { body: string } | null;
    return row ? (JSON.parse(row.body) as LedgerEntry) : null;
  }

  async list(limit = 50): Promise<LedgerSummary[]> {
    const rows = this.db
      .query(
        `SELECT seq, run_id, recorded_at, question, rubric_ver, confidence, confidence_score, engine_ver, entry_hash
         FROM ledger_entries ORDER BY seq DESC LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map((r) => ({
      seq: r.seq,
      runId: r.run_id,
      timestamp: r.recorded_at,
      question: r.question,
      rubricVersion: r.rubric_ver,
      confidenceLevel: r.confidence,
      confidenceScore: r.confidence_score,
      engineVersion: r.engine_ver,
      hash: r.entry_hash,
    }));
  }

  async count(): Promise<number> {
    const row = this.db.query("SELECT COUNT(*) AS n FROM ledger_entries").get() as { n: number };
    return row.n;
  }

  async verifyChain(): Promise<VerifyResult> {
    const rows = this.db.query("SELECT seq, prev_hash, entry_hash, body FROM ledger_entries ORDER BY seq ASC").all() as any[];
    let expectedPrev = "GENESIS";
    let checked = 0;
    for (const row of rows) {
      const parsed = JSON.parse(row.body) as LedgerEntry;
      // The hash is taken over the body WITH prevHash but WITHOUT hash, so the
      // recomputation here must delete exactly the same field.
      const body = { ...parsed };
      delete (body as unknown as Record<string, unknown>).hash;
      const recomputed = hashHex(`${expectedPrev}${canonicalJson(body)}`);
      if (row.prev_hash !== expectedPrev) {
        return { ok: false, checked, brokenAtSeq: row.seq, brokenAtRunId: parsed.runId, reason: "prev_hash does not match the previous entry's hash" };
      }
      if (parsed.prevHash !== expectedPrev || row.entry_hash !== recomputed || parsed.hash !== recomputed) {
        return { ok: false, checked, brokenAtSeq: row.seq, brokenAtRunId: parsed.runId, reason: "stored hash does not match the recomputed hash of the entry body" };
      }
      expectedPrev = recomputed;
      checked += 1;
    }
    return { ok: true, checked, brokenAtSeq: null, brokenAtRunId: null, reason: null };
  }

  /** Escape hatch used only by tests, to prove the DB-level guards work. */
  raw(): Database {
    return this.db;
  }

  // ---- browser verification stream ---------------------------------------

  private lastVerificationHash(): string {
    const row = this.db.query("SELECT entry_hash FROM verification_runs ORDER BY seq DESC LIMIT 1").get() as { entry_hash: string } | null;
    return row?.entry_hash ?? "GENESIS";
  }

  async appendVerification(entry: VerificationRun): Promise<void> {
    if (this.closed) throw new Error("ledger is closed");
    const prev = this.lastVerificationHash();
    const body: Record<string, unknown> = { ...entry, prev_hash: prev };
    delete body.hash;
    const entryHash = hashHex(`${prev}${canonicalJson(body)}`);
    entry.prev_hash = prev;
    entry.hash = entryHash;
    const stored = { ...body, hash: entryHash };
    const t = entry.coverage.totals;
    this.db
      .query(
        `INSERT INTO verification_runs
          (run_id, recorded_at, pack_id, pack_ver, spec_ver, base_url, driver, checks_total, checks_passed, checks_failed, checks_errored, req_total, req_unverified, outcome_digest, prev_hash, entry_hash, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.run_id,
        entry.timestamp,
        entry.pack.id,
        entry.pack.version,
        entry.pack.spec_version,
        entry.app.base_url,
        entry.driver.id,
        t.checks.total,
        t.checks.passed,
        t.checks.failed,
        t.checks.errored,
        t.requirements,
        t.unverified,
        entry.outcome_digest,
        prev,
        entryHash,
        JSON.stringify(stored),
      );
  }

  async getVerification(runId: string): Promise<VerificationRun | null> {
    const row = this.db.query("SELECT body FROM verification_runs WHERE run_id = ?").get(runId) as { body: string } | null;
    return row ? (JSON.parse(row.body) as VerificationRun) : null;
  }

  async listVerifications(limit = 20): Promise<VerificationSummary[]> {
    const rows = this.db
      .query(
        `SELECT seq, run_id, recorded_at, pack_id, pack_ver, base_url, driver, checks_total, checks_passed, checks_failed, checks_errored, req_total, req_unverified, outcome_digest, entry_hash
         FROM verification_runs ORDER BY seq DESC LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map((r) => ({
      seq: r.seq,
      run_id: r.run_id,
      timestamp: r.recorded_at,
      pack_id: r.pack_id,
      pack_version: r.pack_ver,
      base_url: r.base_url,
      driver: r.driver,
      checks: { total: r.checks_total, passed: r.checks_passed, failed: r.checks_failed, errored: r.checks_errored },
      requirements: { total: r.req_total, unverified: r.req_unverified },
      outcome_digest: r.outcome_digest,
      hash: r.entry_hash,
    }));
  }

  async countVerifications(): Promise<number> {
    const row = this.db.query("SELECT COUNT(*) AS n FROM verification_runs").get() as { n: number };
    return row.n;
  }

  async verifyVerificationChain(): Promise<VerifyResult> {
    const rows = this.db.query("SELECT seq, prev_hash, entry_hash, body FROM verification_runs ORDER BY seq ASC").all() as any[];
    let expectedPrev = "GENESIS";
    let checked = 0;
    for (const row of rows) {
      const parsed = JSON.parse(row.body) as VerificationRun;
      const body = { ...parsed } as Record<string, unknown>;
      delete body.hash;
      const recomputed = hashHex(`${expectedPrev}${canonicalJson(body)}`);
      if (row.prev_hash !== expectedPrev) {
        return { ok: false, checked, brokenAtSeq: row.seq, brokenAtRunId: parsed.run_id, reason: "prev_hash does not match the previous verification entry's hash" };
      }
      if (parsed.prev_hash !== expectedPrev || row.entry_hash !== recomputed || parsed.hash !== recomputed) {
        return { ok: false, checked, brokenAtSeq: row.seq, brokenAtRunId: parsed.run_id, reason: "stored hash does not match the recomputed hash of the verification entry body" };
      }
      expectedPrev = recomputed;
      checked += 1;
    }
    return { ok: true, checked, brokenAtSeq: null, brokenAtRunId: null, reason: null };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
