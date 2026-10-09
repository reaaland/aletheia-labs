import type { LedgerEntry } from "../types.ts";

/** Machine-readable output: the ledger entry verbatim, plus the rendered report. */
export function toJsonReport(entry: LedgerEntry, markdown: string): Record<string, unknown> {
  return {
    schema: "aletheia.report/1",
    runId: entry.runId,
    timestamp: entry.timestamp,
    engineVersion: entry.engineVersion,
    question: entry.question,
    rubric: entry.rubric,
    retrieval: entry.retrieval,
    sources: entry.sources,
    claims: entry.claims,
    clusters: entry.clusters,
    scores: entry.scores,
    conflicts: entry.conflicts,
    verdict: entry.verdict,
    providerConfig: entry.providerConfig,
    notes: entry.notes,
    ledger: { hash: entry.hash, prevHash: entry.prevHash },
    reportMarkdown: markdown,
  };
}
