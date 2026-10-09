import type { ClaimCluster, ClaimScore, ExtractedClaim, GroupScore, Rubric } from "../types.ts";
import { intersectionSize, jaccard, significantTerms, stripMarkdown } from "../util/text.ts";
import {
  scoreCorroboration,
  scoreRecency,
  scoreSourceClass,
  scoreSpecificity,
  totalFromDimensions,
} from "./rubric.ts";

/**
 * Group claims that assert (or deny) the same proposition.
 *
 * Deterministic single-pass agglomeration over a fixed ordering: claim order
 * comes from extractClaims, and a claim joins the first existing cluster whose
 * representative it is similar enough to. No randomness, no embeddings, so the
 * same input always yields the same clusters.
 */
export function buildClusters(claims: ExtractedClaim[], rubric: Rubric): ClaimCluster[] {
  const stop = new Set(rubric.clustering.stopwords.map((s) => s.toLowerCase()));
  const threshold = rubric.clustering.jaccardThreshold;
  const minShared = rubric.clustering.minSharedSignificantTerms;

  const termSets = new Map<string, Set<string>>();
  for (const c of claims) termSets.set(c.id, new Set(significantTerms(c.text, stop)));

  interface Working {
    id: string;
    terms: Set<string>;
    claimIds: string[];
    members: Set<string>[];
  }
  const working: Working[] = [];

  // Single-link agglomeration: a claim joins the best cluster for which it is
  // similar enough to *any* existing member. Comparing against the union of a
  // cluster's terms would get stricter as the cluster grows and would never merge
  // two differently-worded statements of the same fact.
  for (const claim of claims) {
    const terms = termSets.get(claim.id) as Set<string>;
    let best: { cluster: Working; score: number } | null = null;
    for (const cluster of working) {
      let sim = 0;
      let shared = 0;
      for (const memberTerms of cluster.members) {
        const s = jaccard(terms, memberTerms);
        const n = intersectionSize(terms, memberTerms);
        if (n >= minShared && (s > sim || (s === sim && n > shared))) {
          sim = s;
          shared = n;
        }
      }
      if (sim >= threshold && (best === null || sim > best.score)) best = { cluster, score: sim };
    }
    if (best) {
      best.cluster.claimIds.push(claim.id);
      best.cluster.members.push(terms);
      for (const t of terms) best.cluster.terms.add(t);
    } else {
      working.push({ id: `K${working.length + 1}`, terms: new Set(terms), claimIds: [claim.id], members: [terms] });
    }
  }

  const byId = new Map(claims.map((c) => [c.id, c]));
  return working
    .map((w) => {
      const members = w.claimIds.map((id) => byId.get(id) as ExtractedClaim);
      const polarityGroups: Record<"assert" | "deny", string[]> = { assert: [], deny: [] };
      for (const m of members) polarityGroups[m.polarity].push(m.id);
      const independentDomains = [...new Set(members.map((m) => m.domain))].sort();
      const conflicted = polarityGroups.assert.length > 0 && polarityGroups.deny.length > 0 &&
        new Set([
          ...members.filter((m) => m.polarity === "assert").map((m) => m.domain),
          ...members.filter((m) => m.polarity === "deny").map((m) => m.domain),
        ]).size > 1;
      return {
        id: w.id,
        terms: [...w.terms].sort(),
        claimIds: w.claimIds,
        polarityGroups,
        independentDomains,
        conflicted,
      } satisfies ClaimCluster;
    })
    .filter((c) => c.claimIds.length > 0);
}

/**
 * Score every claim on every rubric dimension, using corroboration counted
 * within its own polarity group (a source disagreeing does not corroborate).
 */
export function scoreClaims(
  claims: ExtractedClaim[],
  clusters: ClaimCluster[],
  rubric: Rubric,
  runDate: string,
): { scores: ClaimScore[]; groups: GroupScore[] } {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const scores: ClaimScore[] = [];
  const groups: GroupScore[] = [];

  for (const cluster of clusters) {
    for (const polarity of ["assert", "deny"] as const) {
      const ids = cluster.polarityGroups[polarity];
      if (ids.length === 0) continue;
      const members = ids.map((id) => byId.get(id) as ExtractedClaim);
      const groupDomains = [...new Set(members.map((m) => m.domain))].sort();
      const allDomains = [...new Set(cluster.claimIds.map((id) => (byId.get(id) as ExtractedClaim).domain))].sort();

      const claimScores: ClaimScore[] = members.map((m) => {
        const dimensions = [
          scoreSourceClass(rubric, m.sourceClass, m.sourceClassRule),
          scoreCorroboration(rubric, groupDomains, allDomains),
          scoreRecency(rubric, m.publishedAt, m.publishedAt ? "source_metadata" : "unknown", runDate),
          scoreSpecificity(rubric, m.text),
        ];
        return {
          claimId: m.id,
          clusterId: cluster.id,
          polarityGroup: polarity,
          rubricId: rubric.id,
          rubricVersion: rubric.version,
          total: totalFromDimensions(dimensions),
          dimensions,
        };
      });

      scores.push(...claimScores);
      const groupScore = claimScores.reduce((acc, s) => acc + s.total, 0) / claimScores.length;
      const relevance = Math.max(...members.map((m) => m.questionOverlap), 0);
      groups.push({
        clusterId: cluster.id,
        polarity,
        claimIds: ids,
        independentDomains: groupDomains,
        score: Number(groupScore.toFixed(4)),
        relevance: Number(relevance.toFixed(4)),
        rankKey: Number((groupScore * relevance).toFixed(4)),
        claimScores,
      });
    }
  }

  // Rank by relevance x score. A well-sourced but off-topic claim must never
  // become the verdict, so relevance multiplies rather than merely breaking ties.
  const above = rubric.selection?.requireRelevanceAbove ?? 0;
  groups.sort(
    (a, b) =>
      Number(b.relevance > above) - Number(a.relevance > above) ||
      b.rankKey - a.rankKey ||
      b.score - a.score ||
      b.independentDomains.length - a.independentDomains.length ||
      a.clusterId.localeCompare(b.clusterId, "en", { numeric: true }) ||
      a.polarity.localeCompare(b.polarity),
  );
  return { scores, groups };
}

export function termsFor(text: string, rubric: Rubric): string[] {
  const stop = new Set(rubric.clustering.stopwords.map((s) => s.toLowerCase()));
  return significantTerms(stripMarkdown(text), stop);
}
