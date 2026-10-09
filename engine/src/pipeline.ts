import type {
  AdapterOutcome,
  Dissent,
  EngineConfig,
  Env,
  LedgerEntry,
  RetrievalAdapter,
  RunResult,
  SourceDoc,
} from "./types.ts";
import { ENGINE_VERSION, canonicalJson, makeRunId, nowIso, sha256 } from "./util/ids.ts";
import { loadRubric, rubricDigest, applyClassification } from "./grade/rubric.ts";
import { extractClaims } from "./grade/extract.ts";
import { buildClusters, scoreClaims } from "./grade/cluster.ts";
import { detectConflicts } from "./grade/conflicts.ts";
import { computeConfidence } from "./grade/confidence.ts";
import { synthesizeReasoning } from "./reasoning/index.ts";
import { buildDissent } from "./reasoning/heuristic.ts";
import { selectRetrievalAdapters } from "./retrieval/index.ts";
import { openLedger } from "./ledger/index.ts";
import type { Ledger } from "./ledger/types.ts";
import { renderMarkdown } from "./render/markdown.ts";
import { toJsonReport } from "./render/json.ts";
import { significantTerms } from "./util/text.ts";

export interface ResearchOptions {
  question: string;
  urls: string[];
  config: EngineConfig;
  /** Inject adapters (tests, embedded use). Replaces the registry selection. */
  adapters?: RetrievalAdapter[];
  /** Force the run timestamp for reproducible tests. */
  runDate?: string;
  /** Skip writing to the ledger (used by tests that only check the report). */
  skipLedger?: boolean;
  /** Reuse an open ledger. */
  ledger?: Ledger | null;
}

export interface ResearchResult extends RunResult {
  ledgerBackend: string | null;
  ledgerLocation: string | null;
  ledgerNotes: string[];
  ledgerError: string | null;
  outcomes: AdapterOutcome[];
}

export async function runResearch(opts: ResearchOptions): Promise<ResearchResult> {
  const { config } = opts;
  const env: Env = config.env;
  const runDate = opts.runDate ?? nowIso();
  const rubric = loadRubric(config.rubricPath);
  const stop = new Set(rubric.clustering.stopwords.map((s) => s.toLowerCase()));
  const keywords = significantTerms(opts.question, stop).slice(0, 12);

  // ---- 1. retrieval -----------------------------------------------------
  const adapters = opts.adapters ?? selectRetrievalAdapters(config.retrievalAdapterIds);
  const request = {
    question: opts.question,
    keywords,
    urls: opts.urls,
    limit: config.perAdapterLimit,
    timeoutMs: config.timeoutMs,
    offline: config.offline,
    userAgent: config.userAgent,
    rubric,
    env,
  };

  // Adapters are independent, so they run concurrently. Order is preserved in
  // `outcomes`, which keeps ids and the report deterministic regardless of which
  // provider happens to answer first.
  const outcomes: AdapterOutcome[] = await Promise.all(
    adapters.map(async (adapter): Promise<AdapterOutcome> => {
      const started = Date.now();
      if (!adapter.available(env)) {
        const missing = adapter.configKeys.filter((k) => !env[k]);
        return {
          adapter: adapter.id,
          label: adapter.label,
          layer: "retrieval",
          status: "unavailable",
          reason: `adapter not available in this environment (missing ${missing.join(", ") || "required configuration"})`,
          reasonCode: "unconfigured",
          requiredConfig: adapter.configKeys,
          docs: [],
          durationMs: Date.now() - started,
          detail: null,
        };
      }
      try {
        return await adapter.retrieve(request);
      } catch (err) {
        // A buggy or hostile adapter must never take the run down with it.
        return {
          adapter: adapter.id,
          label: adapter.label,
          layer: "retrieval",
          status: "failed",
          reason: `adapter threw: ${err instanceof Error ? err.message : String(err)}`,
          reasonCode: "internal_error",
          requiredConfig: adapter.configKeys,
          docs: [],
          durationMs: Date.now() - started,
          detail: null,
        };
      }
    }),
  );

  // ---- 2. merge and normalise sources -----------------------------------
  const merged: SourceDoc[] = [];
  const seenUrls = new Set<string>();
  for (const outcome of outcomes) {
    for (const doc of outcome.docs) {
      const key = doc.url.split("#")[0];
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      merged.push(doc);
      if (merged.length >= config.maxSources) break;
    }
    if (merged.length >= config.maxSources) break;
  }
  const sources = applyClassification(merged, rubric).map((s, i) => ({ ...s, id: `S${i + 1}` }));

  // ---- 3. extraction, clustering, scoring -------------------------------
  const claims = extractClaims(sources, opts.question, rubric);
  const clusters = buildClusters(claims, rubric);
  const { scores, groups } = scoreClaims(claims, clusters, rubric, runDate);
  const conflicts = detectConflicts(
    clusters.map((c) => ({ id: c.id, claimIds: c.claimIds, polarityGroups: c.polarityGroups, terms: c.terms })),
    claims,
    rubric,
  );

  // ---- 4. confidence (deterministic, rubric-derived) --------------------
  const confidence = computeConfidence({ groups, claims, sources, conflicts, outcomes, rubric });

  // ---- 5. reasoning (prose only, deterministic) ------------------------
  const prose = await synthesizeReasoning({
    question: opts.question,
    groups,
    clusters,
    claims,
    sources,
    conflicts,
    confidence,
    outcomes,
    rubric,
    env,
  });

  const dissent: Dissent[] = buildDissent({
    question: opts.question,
    groups,
    clusters,
    claims,
    sources,
    conflicts,
    confidence,
    outcomes,
    rubric,
    env,
  });

  // ---- 6. assemble the ledger entry -------------------------------------
  const timestamp = runDate;
  const runId = makeRunId(opts.question, timestamp, String(sources.length));
  const entry: LedgerEntry = {
    runId,
    timestamp,
    engineVersion: ENGINE_VERSION,
    question: opts.question,
    keywords,
    rubric: { id: rubric.id, version: rubric.version, sha256: rubricDigest(rubric) },
    retrieval: outcomes.map((o) => ({
      adapter: o.adapter,
      label: o.label,
      status: o.status,
      reason: o.reason,
      reasonCode: o.reasonCode,
      docCount: o.docs.length,
      durationMs: o.durationMs,
      requiredConfig: o.requiredConfig,
    })),
    sources: sources.map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
      publishedAt: s.publishedAt,
      dateSource: s.dateSource,
      retrievalPath: s.retrievalPath,
      retrievalDetail: s.retrievalDetail,
      discoveredVia: s.discoveredVia,
      sourceClass: s.sourceClass,
      sourceClassRule: s.sourceClassRule,
      fetchedAt: s.fetchedAt,
      httpStatus: s.httpStatus,
      meta: s.meta,
      textChars: s.text.length,
      textSha256: sha256(s.text),
      excerpt: s.text.slice(0, 400),
    })),
    claims,
    clusters,
    scores,
    conflicts,
    verdict: {
      answerSummary: prose.answerSummary,
      text: prose.verdict,
      confidence,
      dissent,
      reasoningAdapter: prose.adapterId,
      reasoningMode: prose.mode,
      caveats: prose.caveats,
    },
    providerConfig: describeProviderConfig(env, sources, outcomes),
    notes: [`Extracted ${claims.length} claim(s) into ${clusters.length} cluster(s) from ${sources.length} source(s).`],
    prevHash: null,
    hash: "",
  };

  const markdown = renderMarkdown(entry, { runCommand: buildRunCommand(opts.question, opts.urls) });
  const json = toJsonReport(entry, markdown);

  // ---- 7. append to the ledger -----------------------------------------
  let ledgerBackend: string | null = null;
  let ledgerLocation: string | null = null;
  let ledgerNotes: string[] = [];
  let ledgerError: string | null = null;
  let ledger = opts.ledger ?? null;
  let owned = false;

  if (!opts.skipLedger && config.ledgerEnabled) {
    try {
      if (!ledger) {
        const opened = await openLedger({ dbPath: config.dbPath, databaseUrl: config.databaseUrl });
        ledger = opened.ledger;
        ledgerNotes = opened.notes;
        owned = true;
      }
      await ledger.append(entry);
      ledgerBackend = ledger.backend;
      ledgerLocation = ledger.location;
      const stored = await ledger.get(entry.runId);
      if (stored) entry.hash = stored.hash;
    } catch (err) {
      ledgerError = err instanceof Error ? err.message : String(err);
    } finally {
      if (owned && ledger) await ledger.close();
    }
  }

  const finalMarkdown = ledgerBackend
    ? renderMarkdown(entry, { runCommand: buildRunCommand(opts.question, opts.urls), ledger: { backend: ledgerBackend, location: ledgerLocation } })
    : markdown;

  return {
    entry,
    markdown: finalMarkdown,
    json: ledgerBackend ? toJsonReport(entry, finalMarkdown) : json,
    ledgerBackend,
    ledgerLocation,
    ledgerNotes,
    ledgerError,
    outcomes,
  };
}

export function buildRunCommand(question: string, urls: string[]): string {
  const parts = ["bun run research", JSON.stringify(question)];
  for (const u of urls) parts.push(`--source ${JSON.stringify(u)}`);
  return parts.join(" ");
}

export function describeProviderConfig(env: Env, sources: SourceDoc[], outcomes: AdapterOutcome[]): Record<string, string> {
  const used = new Map<string, string>();
  for (const s of sources) used.set(s.retrievalPath, `${used.get(s.retrievalPath) ?? ""}${used.get(s.retrievalPath) ? ", " : ""}${s.retrievalDetail}`);
  const out: Record<string, string> = {};
  for (const o of outcomes) {
    out[o.adapter] = `${o.status}${used.has(o.adapter) ? ` (backends: ${used.get(o.adapter)})` : ""}`;
  }
  // Only ever record whether a credential exists, never its value.
  for (const key of [
    "BRAVE_API_KEY",
    "TAVILY_API_KEY",
    "SERPER_API_KEY",
    "GOOGLE_CSE_KEY",
    "MOJEEK_API_KEY",
    "STACKEXCHANGE_KEY",
    "GITHUB_TOKEN",
    "ALETHEIA_WEBSEARCH_BACKENDS",
    "ALETHEIA_REGISTRY_BACKENDS",
  ]) {
    const value = env[key];
    if (value === undefined || value === "") continue;
    out[`env:${key}`] = key.endsWith("_KEY") || key.endsWith("_TOKEN") ? "<set:redacted>" : value;
  }
  out["secrets.present"] = Object.keys(env)
    .filter((k) => /(_KEY|_TOKEN|API_KEY)$/.test(k) && env[k])
    .join(",") || "none";
  return out;
}

export { canonicalJson };
