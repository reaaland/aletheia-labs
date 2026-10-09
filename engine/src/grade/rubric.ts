import { readFileSync } from "node:fs";
import type { DimensionScore, Rubric, SourceClass, SourceDoc } from "../types.ts";
import { round, sha256 } from "../util/ids.ts";

/** Loads the rubric from disk. The rubric is data; no scoring lives in code. */
export function loadRubric(path: string): Rubric {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Rubric;
  validateRubric(parsed);
  return parsed;
}

export function rubricDigest(rubric: Rubric): string {
  return sha256(JSON.stringify(rubric, Object.keys(rubric).sort()));
}

export function validateRubric(rubric: Rubric): void {
  const problems: string[] = [];
  if (!rubric.id) problems.push("missing id");
  if (!rubric.version) problems.push("missing version");
  const dims = rubric.dimensions ?? {};
  const names = Object.keys(dims);
  if (names.length === 0) problems.push("no dimensions");
  const sum = names.reduce((acc, n) => acc + (dims[n]?.weight ?? 0), 0);
  if (Math.abs(sum - 1) > 1e-9) problems.push(`dimension weights must sum to 1.0, got ${sum}`);
  for (const required of ["sourceClass", "corroboration", "recency", "specificity"]) {
    if (!dims[required]) problems.push(`missing required dimension: ${required}`);
  }
  if (dims.sourceClass && !dims.sourceClass.scale) problems.push("sourceClass needs a scale");
  if (dims.recency && !dims.recency.curve) problems.push("recency needs a curve");
  if (!rubric.sourceClassRules?.upgrade) problems.push("missing sourceClassRules.upgrade");
  if (!rubric.confidenceModel?.bands?.length) problems.push("missing confidenceModel.bands");
  if ((rubric.conflictPolicy?.rule ?? "") !== "surface_never_average") {
    problems.push("conflictPolicy.rule must be surface_never_average");
  }
  if (problems.length) throw new Error(`invalid rubric at ${rubric.id ?? "?"}: ${problems.join("; ")}`);
}

/**
 * Assign a source class from the rubric's ordered rule list. The matched rule id
 * is recorded so anyone can audit the class assignment.
 */
export function classifySource(
  url: string,
  rubric: Rubric,
): { sourceClass: SourceClass; ruleId: string } {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    host = url.toLowerCase();
    path = "";
  }
  for (const rule of rubric.sourceClassRules.upgrade) {
    const hostOk = rule.host ? new RegExp(rule.host, "i").test(host) : true;
    const pathOk = rule.path ? new RegExp(rule.path, "i").test(path || url) : true;
    if (hostOk && pathOk) return { sourceClass: rule.class, ruleId: rule.id };
  }
  return { sourceClass: rubric.sourceClassRules.default ?? "unknown", ruleId: "default" };
}

/** Re-classify every source (idempotent; safe to re-run over fixtures). */
export function applyClassification(sources: SourceDoc[], rubric: Rubric): SourceDoc[] {
  return sources.map((s) => {
    const { sourceClass, ruleId } = classifySource(s.url, rubric);
    return { ...s, sourceClass, sourceClassRule: ruleId };
  });
}

export function dimensionWeight(rubric: Rubric, name: string): number {
  return rubric.dimensions[name]?.weight ?? 0;
}

function stepLookup(points: { domains: number; [k: string]: number }[], key: string, n: number, above: number): number {
  let best: number | null = null;
  let bestDomains = -1;
  for (const p of points) {
    if (p.domains <= n && p.domains > bestDomains) {
      bestDomains = p.domains;
      best = p[key];
    }
  }
  if (best === null) return 0;
  const maxDomains = Math.max(...points.map((p) => p.domains));
  if (n > maxDomains) return above;
  return best;
}

export function scoreSourceClass(rubric: Rubric, sourceClass: SourceClass, ruleId: string): DimensionScore {
  const dim = rubric.dimensions.sourceClass;
  const scale = dim.scale ?? {};
  const key = sourceClass in scale ? sourceClass : (dim.unknownKey ?? "unknown");
  const score = scale[key] ?? 0;
  return {
    dimension: "sourceClass",
    kind: "categorical",
    weight: dim.weight,
    score: round(score),
    contribution: round(dim.weight * score),
    rawInputs: { sourceClass, ruleId, matchedScaleKey: key, scale },
    explanation: `sourceClass "${sourceClass}" (rule ${ruleId}) -> scale[${key}] = ${score}`,
  };
}

export function scoreCorroboration(rubric: Rubric, independentDomains: string[], domains: string[]): DimensionScore {
  const dim = rubric.dimensions.corroboration;
  const points = (dim.curve?.points ?? []) as { domains: number; score: number }[];
  const above = Number(dim.curve?.above ?? 1);
  const n = new Set(independentDomains).size;
  const score = stepLookup(points, "score", n, above);
  return {
    dimension: "corroboration",
    kind: "numeric",
    weight: dim.weight,
    score: round(score),
    contribution: round(dim.weight * score),
    rawInputs: { independentDomains: [...new Set(independentDomains)].sort(), allDomains: [...new Set(domains)].sort(), count: n, points, above },
    explanation: `${n} independent domain(s) asserting the same proposition -> ${score} (step curve)`,
  };
}

export function scoreRecency(
  rubric: Rubric,
  publishedAt: string | null,
  dateSource: string,
  runDate: string,
): DimensionScore {
  const dim = rubric.dimensions.recency;
  const halfLife = Number(dim.curve?.halfLifeDays ?? 365);
  const floor = Number(dim.curve?.floor ?? 0.1);
  let score: number;
  let ageDays: number | null = null;
  if (!publishedAt) {
    score = Number(dim.unknownScore ?? 0.5);
  } else {
    const then = Date.parse(publishedAt);
    const now = Date.parse(runDate);
    if (!Number.isFinite(then) || !Number.isFinite(now)) {
      score = Number(dim.unknownScore ?? 0.5);
    } else {
      ageDays = Math.max(0, (now - then) / 86_400_000);
      score = Math.max(floor, Math.pow(0.5, ageDays / halfLife));
    }
  }
  return {
    dimension: "recency",
    kind: "numeric",
    weight: dim.weight,
    score: round(score),
    contribution: round(dim.weight * score),
    rawInputs: {
      publishedAt,
      dateSource,
      runDate,
      ageDays: ageDays === null ? null : round(ageDays, 2),
      halfLifeDays: halfLife,
      floor,
    },
    explanation:
      ageDays === null
        ? `no source date -> unknownScore ${score}`
        : `age ${round(ageDays, 2)}d, half-life ${halfLife}d -> max(${floor}, 0.5^(${round(ageDays, 2)}/${halfLife})) = ${round(score)}`,
  };
}

export function detectSignals(rubric: Rubric, text: string): { signals: string[]; score: number } {
  const dim = rubric.dimensions.specificity;
  // The rubric keeps the two halves of this in different places on purpose:
  // `specificitySignals` holds the patterns, `dimensions.specificity.signals`
  // holds their weights. Compiling the weights as patterns would silently score
  // every claim at zero, so the two are read separately here.
  const patterns = rubric.claimExtraction.specificitySignals ?? {};
  const weights = (dim.signals ?? {}) as Record<string, number>;
  const cap = Number(dim.cap ?? 1);
  const matched: string[] = [];
  let total = 0;
  for (const [name, pattern] of Object.entries(patterns)) {
    if (!pattern) continue;
    let hit = false;
    try {
      hit = new RegExp(pattern, "i").test(text);
    } catch {
      hit = false;
    }
    if (hit) {
      matched.push(name);
      total += Number(weights[name] ?? 0);
    }
  }
  return { signals: matched.sort(), score: Math.min(cap, total) };
}

export function scoreSpecificity(rubric: Rubric, text: string): DimensionScore {
  const dim = rubric.dimensions.specificity;
  const { signals, score } = detectSignals(rubric, text);
  return {
    dimension: "specificity",
    kind: "numeric",
    weight: dim.weight,
    score: round(score),
    contribution: round(dim.weight * score),
    rawInputs: { matchedSignals: signals, signalWeights: dim.signals ?? {}, cap: Number(dim.cap ?? 1) },
    explanation: `signals [${signals.join(", ") || "none"}] -> min(cap, ${round(score)}) = ${round(score)}`,
  };
}

/** Weighted sum of the dimension scores. Keeping this in one place keeps it auditable. */
export function totalFromDimensions(dimensions: DimensionScore[]): number {
  return round(dimensions.reduce((acc, d) => acc + d.contribution, 0));
}

export function recomputeTotal(dimensions: DimensionScore[]): number {
  return totalFromDimensions(dimensions);
}
