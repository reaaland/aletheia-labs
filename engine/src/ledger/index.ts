import { SqliteLedger } from "./sqlite.ts";
import { PostgresLedger, redactUrl } from "./postgres.ts";
import type { Ledger, OpenLedgerResult } from "./types.ts";

/**
 * Choose a ledger backend.
 *
 * SQLite file is the default and needs nothing. Postgres is used only when
 * DATABASE_URL is set, and a Postgres failure falls back to the SQLite file with
 * a note rather than killing the run -- the ledger must never be the reason a
 * research run dies.
 */
export async function openLedger(opts: { dbPath: string; databaseUrl: string | null }): Promise<OpenLedgerResult> {
  const notes: string[] = [];
  if (opts.databaseUrl) {
    try {
      const ledger = await PostgresLedger.open(opts.databaseUrl);
      notes.push(`using the Postgres ledger at ${redactUrl(opts.databaseUrl)} because DATABASE_URL is set`);
      return { ledger, notes };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      notes.push(`DATABASE_URL is set but the Postgres ledger could not be opened (${reason}); falling back to the SQLite file at ${opts.dbPath}`);
    }
  }
  const ledger = new SqliteLedger(opts.dbPath);
  return { ledger, notes };
}

export { SqliteLedger, PostgresLedger };
export type { Ledger, LedgerSummary, VerifyResult, OpenLedgerResult } from "./types.ts";
export type { VerificationRun, VerificationSummary } from "../browser/types.ts";
