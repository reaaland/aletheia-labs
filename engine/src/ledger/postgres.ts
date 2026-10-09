import type { LedgerEntry } from "../types.ts";
import type { VerificationRun, VerificationSummary } from "../browser/types.ts";
import { canonicalJson, hashHex, nowIso } from "../util/ids.ts";
import type { Ledger, LedgerSummary, VerifyResult } from "./types.ts";

/**
 * Postgres ledger. Used only when DATABASE_URL happens to be set; it is never
 * required to run the engine, the demo or the tests.
 *
 * It uses Bun's built-in Postgres client, resolved at runtime, so a missing or
 * older Bun degrades to a clear error the caller can handle (the caller falls
 * back to SQLite) rather than a broken import at module load.
 */
export class PostgresLedger implements Ledger {
  readonly backend = "postgres" as const;
  readonly location: string;
  private sql: any;

  private constructor(sql: any, url: string) {
    this.sql = sql;
    this.location = redactUrl(url);
  }

  static async open(url: string): Promise<PostgresLedger> {
    const factory = (Bun as unknown as { sql?: (u: string, o?: unknown) => any }).sql;
    if (typeof factory !== "function") {
      throw new Error("this Bun runtime has no built-in Postgres client (Bun.sql); cannot use DATABASE_URL");
    }
    const sql = factory.call(Bun, url, { max: 4 });
    const ledger = new PostgresLedger(sql, url);
    await ledger.migrate();
    return ledger;
  }

  private async migrate(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS ledger_entries (
        seq         BIGSERIAL PRIMARY KEY,
        run_id      TEXT NOT NULL UNIQUE,
        recorded_at TIMESTAMPTZ NOT NULL,
        question    TEXT NOT NULL,
        rubric_id   TEXT NOT NULL,
        rubric_ver  TEXT NOT NULL,
        confidence  TEXT NOT NULL,
        confidence_score DOUBLE PRECISION NOT NULL,
        engine_ver  TEXT NOT NULL,
        supersedes  TEXT,
        prev_hash   TEXT NOT NULL,
        entry_hash  TEXT NOT NULL,
        body        JSONB NOT NULL
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_ledger_question ON ledger_entries(question)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_ledger_recorded ON ledger_entries(recorded_at)`;
    await this.sql`
      CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ledger is append-only: entries cannot be modified or deleted (append a correction instead)';
      END;
      $$ LANGUAGE plpgsql
    `;
    await this.sql`DROP TRIGGER IF EXISTS ledger_entries_append_only_update ON ledger_entries`;
    await this.sql`DROP TRIGGER IF EXISTS ledger_entries_append_only_delete ON ledger_entries`;
    await this.sql`
      CREATE TRIGGER ledger_entries_append_only_update BEFORE UPDATE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_append_only()
    `;
    await this.sql`
      CREATE TRIGGER ledger_entries_append_only_delete BEFORE DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_append_only()
    `;
    await this.sql`CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS verification_runs (
        seq             BIGSERIAL PRIMARY KEY,
        run_id          TEXT NOT NULL UNIQUE,
        recorded_at     TIMESTAMPTZ NOT NULL,
        pack_id         TEXT NOT NULL,
        pack_ver        TEXT NOT NULL,
        spec_ver        INTEGER NOT NULL,
        base_url        TEXT NOT NULL,
        driver          TEXT NOT NULL,
        checks_total    INTEGER NOT NULL,
        checks_passed   INTEGER NOT NULL,
        checks_failed   INTEGER NOT NULL,
        checks_errored  INTEGER NOT NULL,
        req_total       INTEGER NOT NULL,
        req_unverified  INTEGER NOT NULL,
        outcome_digest  TEXT NOT NULL,
        prev_hash       TEXT NOT NULL,
        entry_hash      TEXT NOT NULL,
        body            JSONB NOT NULL
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_verification_pack ON verification_runs(pack_id)`;
    await this.sql`DROP TRIGGER IF EXISTS verification_runs_append_only_update ON verification_runs`;
    await this.sql`DROP TRIGGER IF EXISTS verification_runs_append_only_delete ON verification_runs`;
    await this.sql`
      CREATE TRIGGER verification_runs_append_only_update BEFORE UPDATE ON verification_runs
      FOR EACH ROW EXECUTE FUNCTION ledger_append_only()
    `;
    await this.sql`
      CREATE TRIGGER verification_runs_append_only_delete BEFORE DELETE ON verification_runs
      FOR EACH ROW EXECUTE FUNCTION ledger_append_only()
    `;
    await this.sql`
      INSERT INTO ledger_meta (key, value) VALUES ('genesis', ${`${nowIso()}|${hashHex("aletheia-genesis")}`})
      ON CONFLICT (key) DO NOTHING
    `;
  }

  async append(entry: LedgerEntry): Promise<void> {
    const prev = await this.lastHash();
    const body: Record<string, unknown> = { ...entry, prevHash: prev };
    delete body.hash;
    const entryHash = hashHex(`${prev}${canonicalJson(body)}`);
    const full = { ...body, hash: entryHash } as LedgerEntry;
    await this.sql`
      INSERT INTO ledger_entries
        (run_id, recorded_at, question, rubric_id, rubric_ver, confidence, confidence_score, engine_ver, supersedes, prev_hash, entry_hash, body)
      VALUES (${full.runId}, ${full.timestamp}, ${full.question}, ${full.rubric.id}, ${full.rubric.version},
              ${full.verdict.confidence.level}, ${full.verdict.confidence.score}, ${full.engineVersion},
              ${(full as unknown as { supersedes?: string }).supersedes ?? null}, ${prev}, ${entryHash}, ${JSON.stringify(full)}::jsonb)
    `;
  }

  private async lastHash(): Promise<string> {
    const rows = await this.sql`SELECT entry_hash FROM ledger_entries ORDER BY seq DESC LIMIT 1`;
    const list = Array.isArray(rows) ? rows : [];
    return list.length > 0 ? String(list[0].entry_hash) : "GENESIS";
  }

  async get(runId: string): Promise<LedgerEntry | null> {
    const rows = await this.sql`SELECT body FROM ledger_entries WHERE run_id = ${runId}`;
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return null;
    const body = list[0].body;
    return (typeof body === "string" ? JSON.parse(body) : body) as LedgerEntry;
  }

  async list(limit = 50): Promise<LedgerSummary[]> {
    const rows = await this.sql`
      SELECT seq, run_id, recorded_at, question, rubric_ver, confidence, confidence_score, engine_ver, entry_hash
      FROM ledger_entries ORDER BY seq DESC LIMIT ${limit}`;
    return (Array.isArray(rows) ? rows : []).map((r: any) => ({
      seq: Number(r.seq),
      runId: String(r.run_id),
      timestamp: String(r.recorded_at),
      question: String(r.question),
      rubricVersion: String(r.rubric_ver),
      confidenceLevel: String(r.confidence),
      confidenceScore: Number(r.confidence_score),
      engineVersion: String(r.engine_ver),
      hash: String(r.entry_hash),
    }));
  }

  async count(): Promise<number> {
    const rows = await this.sql`SELECT COUNT(*)::int AS n FROM ledger_entries`;
    const list = Array.isArray(rows) ? rows : [];
    return list.length > 0 ? Number(list[0].n) : 0;
  }

  async verifyChain(): Promise<VerifyResult> {
    const rows = await this.sql`SELECT seq, prev_hash, entry_hash, body FROM ledger_entries ORDER BY seq ASC`;
    const list = Array.isArray(rows) ? rows : [];
    let expectedPrev = "GENESIS";
    let checked = 0;
    for (const row of list) {
      const parsed = (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as LedgerEntry;
      const body: Record<string, unknown> = { ...parsed };
      delete body.hash;
      const recomputed = hashHex(`${expectedPrev}${canonicalJson(body)}`);
      if (row.prev_hash !== expectedPrev) {
        return { ok: false, checked, brokenAtSeq: Number(row.seq), brokenAtRunId: parsed.runId, reason: "prev_hash mismatch" };
      }
      if (row.entry_hash !== recomputed || parsed.hash !== recomputed) {
        return { ok: false, checked, brokenAtSeq: Number(row.seq), brokenAtRunId: parsed.runId, reason: "hash mismatch" };
      }
      expectedPrev = recomputed;
      checked += 1;
    }
    return { ok: true, checked, brokenAtSeq: null, brokenAtRunId: null, reason: null };
  }

  async close(): Promise<void> {
    try {
      await this.sql.end?.();
    } catch {
      /* connection already gone */
    }
  }

  // ---- browser verification stream (same guarantees, separate chain) ------

  async appendVerification(entry: VerificationRun): Promise<void> {
    const prev = await this.lastVerificationHash();
    const body: Record<string, unknown> = { ...entry, prev_hash: prev };
    delete body.hash;
    const entryHash = hashHex(`${prev}${canonicalJson(body)}`);
    entry.prev_hash = prev;
    entry.hash = entryHash;
    const stored = { ...body, hash: entryHash };
    const t = entry.coverage.totals;
    await this.sql`
      INSERT INTO verification_runs
        (run_id, recorded_at, pack_id, pack_ver, spec_ver, base_url, driver, checks_total, checks_passed, checks_failed, checks_errored, req_total, req_unverified, outcome_digest, prev_hash, entry_hash, body)
      VALUES (${entry.run_id}, ${entry.timestamp}, ${entry.pack.id}, ${entry.pack.version}, ${entry.pack.spec_version}, ${entry.app.base_url},
              ${entry.driver.id}, ${t.checks.total}, ${t.checks.passed}, ${t.checks.failed}, ${t.checks.errored}, ${t.requirements}, ${t.unverified},
              ${entry.outcome_digest}, ${prev}, ${entryHash}, ${JSON.stringify(stored)}::jsonb)
    `;
  }

  private async lastVerificationHash(): Promise<string> {
    const rows = await this.sql`SELECT entry_hash FROM verification_runs ORDER BY seq DESC LIMIT 1`;
    const list = Array.isArray(rows) ? rows : [];
    return list.length > 0 ? String(list[0].entry_hash) : "GENESIS";
  }

  async getVerification(runId: string): Promise<VerificationRun | null> {
    const rows = await this.sql`SELECT body FROM verification_runs WHERE run_id = ${runId}`;
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return null;
    const body = list[0].body;
    return (typeof body === "string" ? JSON.parse(body) : body) as VerificationRun;
  }

  async listVerifications(limit = 20): Promise<VerificationSummary[]> {
    const rows = await this.sql`
      SELECT seq, run_id, recorded_at, pack_id, pack_ver, base_url, driver, checks_total, checks_passed, checks_failed, checks_errored, req_total, req_unverified, outcome_digest, entry_hash
      FROM verification_runs ORDER BY seq DESC LIMIT ${limit}`;
    return (Array.isArray(rows) ? rows : []).map((r: any) => ({
      seq: Number(r.seq),
      run_id: String(r.run_id),
      timestamp: String(r.recorded_at),
      pack_id: String(r.pack_id),
      pack_version: String(r.pack_ver),
      base_url: String(r.base_url),
      driver: String(r.driver),
      checks: { total: Number(r.checks_total), passed: Number(r.checks_passed), failed: Number(r.checks_failed), errored: Number(r.checks_errored) },
      requirements: { total: Number(r.req_total), unverified: Number(r.req_unverified) },
      outcome_digest: String(r.outcome_digest),
      hash: String(r.entry_hash),
    }));
  }

  async countVerifications(): Promise<number> {
    const rows = await this.sql`SELECT COUNT(*)::int AS n FROM verification_runs`;
    const list = Array.isArray(rows) ? rows : [];
    return list.length > 0 ? Number(list[0].n) : 0;
  }

  async verifyVerificationChain(): Promise<VerifyResult> {
    const rows = await this.sql`SELECT seq, prev_hash, entry_hash, body FROM verification_runs ORDER BY seq ASC`;
    const list = Array.isArray(rows) ? rows : [];
    let expectedPrev = "GENESIS";
    let checked = 0;
    for (const row of list) {
      const parsed = (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as VerificationRun;
      const body: Record<string, unknown> = { ...parsed };
      delete body.hash;
      const recomputed = hashHex(`${expectedPrev}${canonicalJson(body)}`);
      if (row.prev_hash !== expectedPrev) {
        return { ok: false, checked, brokenAtSeq: Number(row.seq), brokenAtRunId: parsed.run_id, reason: "prev_hash mismatch" };
      }
      if (row.entry_hash !== recomputed || parsed.hash !== recomputed) {
        return { ok: false, checked, brokenAtSeq: Number(row.seq), brokenAtRunId: parsed.run_id, reason: "hash mismatch" };
      }
      expectedPrev = recomputed;
      checked += 1;
    }
    return { ok: true, checked, brokenAtSeq: null, brokenAtRunId: null, reason: null };
  }
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.password = u.password ? "***" : "";
    if (u.username) u.username = "***";
    return u.toString();
  } catch {
    return "postgres://<unparseable>";
  }
}
