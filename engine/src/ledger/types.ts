import type { LedgerEntry } from "../types.ts";
import type { VerificationRun, VerificationSummary } from "../browser/types.ts";

export interface LedgerSummary {
  seq: number;
  runId: string;
  timestamp: string;
  question: string;
  rubricVersion: string;
  confidenceLevel: string;
  confidenceScore: number;
  engineVersion: string;
  hash: string;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  brokenAtSeq: number | null;
  brokenAtRunId: string | null;
  reason: string | null;
}

/**
 * The ledger contract. Deliberately has no update and no delete: an append-only
 * log is only append-only if the interface cannot express anything else.
 * A correction is a new entry that supersedes an earlier one.
 *
 * Two independent append-only streams live in the same ledger: research runs
 * (append/get/list/verifyChain) and browser verification runs
 * (appendVerification/getVerification/listVerifications/verifyVerificationChain).
 * Each has its own hash chain. They are kept apart because a research entry
 * carries a graded answer and a verification entry carries executed checks;
 * merging them into one row shape would force one of them to lie about a field.
 */
export interface Ledger {
  readonly backend: "sqlite" | "postgres";
  readonly location: string;
  append(entry: LedgerEntry): Promise<void>;
  get(runId: string): Promise<LedgerEntry | null>;
  list(limit?: number): Promise<LedgerSummary[]>;
  count(): Promise<number>;
  verifyChain(): Promise<VerifyResult>;
  /** Appends one verification run and fills in its prev_hash/hash. */
  appendVerification(entry: VerificationRun): Promise<void>;
  getVerification(runId: string): Promise<VerificationRun | null>;
  listVerifications(limit?: number): Promise<VerificationSummary[]>;
  countVerifications(): Promise<number>;
  verifyVerificationChain(): Promise<VerifyResult>;
  close(): Promise<void>;
}

export interface OpenLedgerResult {
  ledger: Ledger;
  notes: string[];
}

export type { LedgerEntry, VerificationRun, VerificationSummary };
