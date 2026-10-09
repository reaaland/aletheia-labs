/**
 * Core domain types for the Aletheia research core.
 *
 * Nothing in here names a vendor. Retrieval and reasoning are both expressed as
 * adapter interfaces; the pipeline only ever talks to these interfaces.
 */

export type Layer = "retrieval" | "reasoning";

export type SourceClass =
  | "standards_spec"
  | "primary_documentation"
  | "first_party_changelog"
  | "vendor_blog"
  | "qa_forum"
  | "aggregator"
  | "unknown";

export type FailureCode =
  | "unconfigured"
  | "rate_limited"
  | "timeout"
  | "http_error"
  | "network_error"
  | "parse_error"
  | "empty_result"
  | "auth_error"
  | "blocked"
  | "disabled"
  | "internal_error";

export type AdapterStatus = "ok" | "partial" | "unavailable" | "failed";

/** A single retrieved document, normalised across every retrieval path. */
export interface SourceDoc {
  /** Stable id within a run, e.g. "S1". Referenced by claims and citations. */
  id: string;
  url: string;
  title: string;
  /** Plain text body, already stripped of markup. */
  text: string;
  /** ISO-8601 date the document was published/updated, when the path knows it. */
  publishedAt: string | null;
  /** Date provenance, so recency can be recomputed by hand. */
  dateSource: "source_metadata" | "http_header" | "fetched_at" | "unknown";
  /** Adapter id that produced this document, e.g. "direct-url". */
  retrievalPath: string;
  /** Backend within the adapter, e.g. "npm" or "marginalia". */
  retrievalDetail: string;
  /** Where the URL came from, so a human can audit the discovery step. */
  discoveredVia: string;
  sourceClass: SourceClass;
  /** Rule id from the rubric that assigned sourceClass. */
  sourceClassRule: string;
  fetchedAt: string;
  httpStatus: number | null;
  meta: Record<string, unknown>;
}

/** What one retrieval adapter did on one run. Never throws out of the pipeline. */
export interface AdapterOutcome {
  adapter: string;
  label: string;
  layer: Layer;
  status: AdapterStatus;
  /** Human-readable explanation, always present when status !== "ok". */
  reason: string | null;
  reasonCode: FailureCode | null;
  /** Which configuration keys would make this adapter available. */
  requiredConfig: string[];
  docs: SourceDoc[];
  durationMs: number;
  detail: string | null;
}

export interface RetrievalRequest {
  question: string;
  /** Significant terms extracted from the question, used by structured backends. */
  keywords: string[];
  /** User-supplied URLs (--source). */
  urls: string[];
  limit: number;
  timeoutMs: number;
  offline: boolean;
  userAgent: string;
  /** The loaded rubric, so adapters can classify sources without re-reading disk. */
  rubric: Rubric;
  env: Env;
}

export interface RetrievalAdapter {
  readonly layer: "retrieval";
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Env var names this adapter reads. Empty means it needs no configuration. */
  readonly configKeys: string[];
  /** False => the pipeline records an "unavailable/unconfigured" outcome. */
  available(env: Env): boolean;
  /** Must never throw. Implementations return AdapterOutcome. */
  retrieve(req: RetrievalRequest): Promise<AdapterOutcome>;
}

export interface ExtractedClaim {
  id: string;
  sourceId: string;
  sourceUrl: string;
  retrievalPath: string;
  retrievalDetail: string;
  sourceClass: SourceClass;
  /** Rubric rule id that assigned sourceClass; recorded so the score is auditable. */
  sourceClassRule: string;
  domain: string;
  publishedAt: string | null;
  text: string;
  /** "assert" claims the proposition; "deny" negates a proposition in it. */
  polarity: "assert" | "deny";
  negationCue: string | null;
  assertionCue: string | null;
  matchedSignals: string[];
  termCount: number;
  questionOverlap: number;
}

export interface ClaimCluster {
  id: string;
  terms: string[];
  claimIds: string[];
  polarityGroups: Record<"assert" | "deny", string[]>;
  independentDomains: string[];
  conflicted: boolean;
}

export interface DimensionScore {
  dimension: string;
  kind: string;
  rawInputs: Record<string, unknown>;
  score: number;
  weight: number;
  contribution: number;
  explanation: string;
}

export interface ClaimScore {
  claimId: string;
  clusterId: string;
  polarityGroup: "assert" | "deny";
  rubricId: string;
  rubricVersion: string;
  total: number;
  dimensions: DimensionScore[];
}

export interface GroupScore {
  clusterId: string;
  polarity: "assert" | "deny";
  claimIds: string[];
  independentDomains: string[];
  score: number;
  /** Relevance of this group to the question (max questionOverlap of its claims). */
  relevance: number;
  /** relevance * score: what the engine ranks groups by. */
  rankKey: number;
  claimScores: ClaimScore[];
}

export interface Conflict {
  id: string;
  clusterId: string;
  kind: "polarity" | "value";
  significance: "material" | "minor";
  topic: string;
  sideA: ConflictSide;
  sideB: ConflictSide;
  resolution: "not_averaged";
  note: string;
  values?: { sideA: string[]; sideB: string[] };
}

export interface ConflictSide {
  claimIds: string[];
  domains: string[];
  excerpts: { claimId: string; sourceId: string; url: string; sourceClass: SourceClass; text: string }[];
}

export interface ConfidenceInputs {
  primaryGroupScore: number;
  secondaryGroupScore: number;
  independentDomainCount: number;
  coverageFactor: number;
  authoritativeSourcePresent: boolean;
  authorityFactor: number;
  conflictsMaterial: number;
  conflictsMinor: number;
  conflictPenalty: number;
  adaptersAvailable: number;
  adaptersTotal: number;
  retrievalFactor: number;
  supportingClaimCount: number;
  sourcesByClass: Record<string, number>;
}

export interface Confidence {
  level: "high" | "moderate" | "low" | "very_low";
  score: number;
  bandMin: number;
  inputs: ConfidenceInputs;
  formula: string;
  explanation: string;
}

export interface ReasoningRequest {
  question: string;
  groups: GroupScore[];
  clusters: ClaimCluster[];
  claims: ExtractedClaim[];
  sources: SourceDoc[];
  conflicts: Conflict[];
  confidence: Confidence;
  outcomes: AdapterOutcome[];
  rubric: Rubric;
  env: Env;
}

export interface ReasoningResult {
  /** Markdown prose for the verdict section. */
  verdict: string;
  /** Direct one-line answer to the question, if the adapter can produce one. */
  answerSummary: string;
  /**
   * How the prose was produced. Recorded in the ledger and the report.
   * Exactly one value exists: the deterministic template reasoner.
   */
  mode: "deterministic_template";
  /** Anything the reader should know about how the prose was made. */
  caveats: string[];
  adapterId: string;
  adapterLabel: string;
  durationMs: number;
}

export interface ReasoningAdapter {
  readonly layer: "reasoning";
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly configKeys: string[];
  /** True for the deterministic, credential-free path. */
  readonly deterministic: boolean;
  available(env: Env): boolean;
  /** Must never throw. Fall back to a degraded result instead. */
  synthesize(req: ReasoningRequest): Promise<ReasoningResult>;
}

export interface RubricDimension {
  weight: number;
  kind: string;
  question?: string;
  scale?: Record<string, number>;
  unknownKey?: string;
  curve?: Record<string, unknown>;
  unknownScore?: number;
  signals?: Record<string, number>;
  cap?: number;
  independentBy?: string;
  recompute?: string;
  [k: string]: unknown;
}

export interface Rubric {
  id: string;
  version: string;
  released?: string;
  weightsSum?: number;
  dimensions: Record<string, RubricDimension>;
  sourceClassRules: {
    upgrade: { id: string; class: SourceClass; host?: string; path?: string }[];
    default: SourceClass;
    notes?: string[];
  };
  clustering: {
    jaccardThreshold: number;
    minSharedSignificantTerms: number;
    stopwords: string[];
    minTokensPerClaim: number;
    minCharsPerClaim: number;
  };
  claimExtraction: {
    assertionCues: string[];
    negationCues: string[];
    boilerplateCues?: string[];
    specificitySignals: Record<string, string>;
  };
  selection: {
    rankKey: string;
    relevanceDefinition: string;
    requireRelevanceAbove: number;
    tieBreak: string[];
  };
  conflictPolicy: {
    rule: string;
    statement: string;
    confidencePenaltyPerConflict: number;
    maxConfidencePenalty: number;
    valueConflictPenaltyPerConflict: number;
  };
  confidenceModel: {
    base: string;
    factors: Record<string, any>;
    bands: { min: number; label: Confidence["level"] }[];
  };
  reporting: { maxClaimsPerGroup: number; maxSourcesShown: number; citationStyle: string };
  [k: string]: unknown;
}

export interface LedgerSourceRecord extends Omit<SourceDoc, "text"> {
  textChars: number;
  textSha256: string;
  excerpt: string;
}

export interface LedgerEntry {
  runId: string;
  timestamp: string;
  engineVersion: string;
  question: string;
  keywords: string[];
  rubric: { id: string; version: string; sha256: string };
  retrieval: {
    adapter: string;
    label: string;
    status: AdapterStatus;
    reason: string | null;
    reasonCode: FailureCode | null;
    docCount: number;
    durationMs: number;
    requiredConfig: string[];
  }[];
  sources: LedgerSourceRecord[];
  claims: ExtractedClaim[];
  clusters: ClaimCluster[];
  scores: ClaimScore[];
  conflicts: Conflict[];
  verdict: {
    answerSummary: string;
    text: string;
    confidence: Confidence;
    dissent: Dissent[];
    reasoningAdapter: string;
    reasoningMode: ReasoningResult["mode"];
    caveats: string[];
  };
  providerConfig: Record<string, string>;
  notes: string[];
  /** Append-only hash chain. hash = sha256(prevHash + canonical(entryWithoutHashFields)). */
  prevHash: string | null;
  hash: string;
}

export interface Dissent {
  kind: "conflict" | "unavailable_provider" | "weak_evidence" | "note";
  summary: string;
  claimIds?: string[];
  sources?: string[];
}

export interface RunResult {
  entry: LedgerEntry;
  markdown: string;
  json: unknown;
}

export type Env = Record<string, string | undefined>;

export interface EngineConfig {
  dbPath: string;
  databaseUrl: string | null;
  rubricPath: string;
  retrievalAdapterIds: string[];
  timeoutMs: number;
  maxSources: number;
  perAdapterLimit: number;
  userAgent: string;
  offline: boolean;
  env: Env;
  ledgerEnabled: boolean;
}
