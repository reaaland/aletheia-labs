import type { AdapterOutcome, Confidence, ConfidenceInputs, Conflict, ExtractedClaim, GroupScore, Rubric, SourceDoc } from "../types.ts";
import { round } from "../util/ids.ts";

const AUTHORITATIVE: string[] = ["standards_spec", "primary_documentation", "first_party_changelog"];

/**
 * Deterministic confidence. The reasoning adapter never supplies this number --
 * it is computed from the recorded evidence so a human can recompute it with a
 * calculator. Every factor and its raw input is returned in `inputs`.
 */
export function computeConfidence(args: {
  groups: GroupScore[];
  claims: ExtractedClaim[];
  sources: SourceDoc[];
  conflicts: Conflict[];
  outcomes: AdapterOutcome[];
  rubric: Rubric;
}): Confidence {
  const { groups, claims, sources, conflicts, outcomes, rubric } = args;
  const model = rubric.confidenceModel;
  const byId = new Map(claims.map((c) => [c.id, c]));

  const primary = groups[0] ?? null;
  const secondary = groups.find((g) => primary && g.clusterId === primary.clusterId && g.polarity !== primary.polarity)
    ?? groups[1]
    ?? null;

  const primaryGroupScore = primary ? primary.score : 0;
  const secondaryGroupScore = secondary ? secondary.score : 0;

  const supportingIds = primary ? primary.claimIds : [];
  const supportingClaims = supportingIds.map((id) => byId.get(id)).filter(Boolean) as ExtractedClaim[];
  const independentDomainCount = primary ? primary.independentDomains.length : 0;

  const coveragePoints = (model.factors.coverage?.points ?? []) as { domains: number; factor: number }[];
  const coverageAbove = Number(model.factors.coverage?.above ?? 1);
  const coverageFactor = lerpStep(coveragePoints, independentDomainCount, coverageAbove);

  const authoritativeSourcePresent = supportingClaims.some((c) => AUTHORITATIVE.includes(c.sourceClass));
  const authorityFactor = authoritativeSourcePresent
    ? 1
    : Number(model.factors.authority?.noAuthoritativeSourceFactor ?? 0.75);

  const material = conflicts.filter((c) => c.significance === "material").length;
  const minor = conflicts.filter((c) => c.significance === "minor").length;
  const rawPenalty =
    material * rubric.conflictPolicy.confidencePenaltyPerConflict +
    minor * rubric.conflictPolicy.valueConflictPenaltyPerConflict;
  const conflictPenalty = Math.min(rubric.conflictPolicy.maxConfidencePenalty, rawPenalty);

  const adaptersTotal = outcomes.length;
  const adaptersAvailable = outcomes.filter((o) => o.status === "ok" || o.status === "partial").length;
  const unavailableRatio = adaptersTotal === 0 ? 0 : (adaptersTotal - adaptersAvailable) / adaptersTotal;
  const threshold = Number(model.factors.retrieval?.unavailableRatioThreshold ?? 0.34);
  const retrievalFactor = unavailableRatio > threshold ? Number(model.factors.retrieval?.degradedFactor ?? 0.8) : 1;

  const sourcesByClass: Record<string, number> = {};
  for (const s of sources) sourcesByClass[s.sourceClass] = (sourcesByClass[s.sourceClass] ?? 0) + 1;

  const score = round(
    Math.max(0, Math.min(1, primaryGroupScore * coverageFactor * authorityFactor * retrievalFactor * (1 - conflictPenalty))),
  );
  const band = (model.bands ?? []).find((b) => score >= b.min) ?? { min: 0, label: "very_low" as const };

  const inputs: ConfidenceInputs = {
    primaryGroupScore: round(primaryGroupScore),
    secondaryGroupScore: round(secondaryGroupScore),
    independentDomainCount,
    coverageFactor: round(coverageFactor),
    authoritativeSourcePresent,
    authorityFactor: round(authorityFactor),
    conflictsMaterial: material,
    conflictsMinor: minor,
    conflictPenalty: round(conflictPenalty),
    adaptersAvailable,
    adaptersTotal,
    retrievalFactor: round(retrievalFactor),
    supportingClaimCount: supportingClaims.length,
    sourcesByClass,
  };

  const formula =
    "score = primaryGroupScore x coverageFactor x authorityFactor x retrievalFactor x (1 - conflictPenalty)";
  const explanation = [
    `primary group score ${inputs.primaryGroupScore}`,
    `coverage ${inputs.coverageFactor} (${independentDomainCount} independent domain(s))`,
    `authority ${inputs.authorityFactor} (${authoritativeSourcePresent ? "authoritative source present" : "no standards/primary/changelog source"})`,
    `retrieval ${inputs.retrievalFactor} (${adaptersAvailable}/${adaptersTotal} adapters answered)`,
    `conflict penalty ${inputs.conflictPenalty} (${material} material, ${minor} minor)`,
    `=> ${score} (${band.label})`,
  ].join("; ");

  return {
    level: band.label,
    score,
    bandMin: band.min,
    inputs,
    formula,
    explanation,
  };
}

function lerpStep(points: { domains: number; factor: number }[], n: number, above: number): number {
  if (points.length === 0) return 1;
  const maxDomains = Math.max(...points.map((p) => p.domains));
  if (n > maxDomains) return above;
  let best: number | null = null;
  let bestDomains = -1;
  for (const p of points) {
    if (p.domains <= n && p.domains > bestDomains) {
      bestDomains = p.domains;
      best = p.factor;
    }
  }
  return best ?? 0;
}
