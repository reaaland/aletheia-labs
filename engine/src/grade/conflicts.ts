import type { Conflict, ConflictSide, ExtractedClaim, Rubric } from "../types.ts";
import { truncate } from "../util/text.ts";

/**
 * Conflict detection. Two independent kinds:
 *
 *  - polarity: one source asserts the proposition, another denies it.
 *  - value:    sources agree on the topic but disagree on the concrete value
 *              (version numbers, dates, DEP/CVE identifiers).
 *
 * Conflicts are returned as first-class records. The engine never averages
 * opposing claims into one number -- see rubric.conflictPolicy.
 */
export function detectConflicts(
  clusters: { id: string; claimIds: string[]; polarityGroups: Record<"assert" | "deny", string[]>; terms: string[] }[],
  claims: ExtractedClaim[],
  rubric: Rubric,
): Conflict[] {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const out: Conflict[] = [];
  const materialPenalty = rubric.conflictPolicy.confidencePenaltyPerConflict;
  void materialPenalty;

  for (const cluster of clusters) {
    const members = cluster.claimIds.map((id) => byId.get(id) as ExtractedClaim).filter(Boolean);
    if (members.length === 0) continue;
    const topic = truncate(clusterTerms(cluster.terms), 160);

    // --- polarity conflicts -------------------------------------------------
    const asserts = members.filter((m) => m.polarity === "assert");
    const denies = members.filter((m) => m.polarity === "deny");
    if (asserts.length > 0 && denies.length > 0) {
      const aDomains = [...new Set(asserts.map((m) => m.domain))].sort();
      const bDomains = [...new Set(denies.map((m) => m.domain))].sort();
      const differentPlaces = aDomains.some((d) => !bDomains.includes(d)) || bDomains.some((d) => !aDomains.includes(d));
      // A contradiction only counts when both sides negate/assert the SAME
      // predicate ("not deprecated" vs "deprecated"). Without this, two sentences
      // about the same topic but different claims ("warning is harmless" vs
      // "module is deprecated") would be dressed up as a disagreement.
      const opposed = opposingPair(asserts, denies);
      if (differentPlaces && opposed) {
        out.push({
          id: `X${out.length + 1}`,
          clusterId: cluster.id,
          kind: "polarity",
          significance: "material",
          topic,
          sideA: side(asserts),
          sideB: side(denies),
          resolution: "not_averaged",
          note:
            `Independent sources take opposite positions on the predicate "${opposed.predicate}" ` +
            `(asserted by ${opposed.a.domain} using "${opposed.a.assertionCue}", denied by ${opposed.d.domain} using "${opposed.d.negationCue}"). ` +
            "Both sides are reported; the engine does not average them.",
        });
      }
    }

    // --- value conflicts ----------------------------------------------------
    const values = new Map<string, ExtractedClaim[]>();
    for (const m of members) {
      for (const v of extractValues(m.text)) {
        const list = values.get(v) ?? [];
        list.push(m);
        values.set(v, list);
      }
    }
    const valueGroups = [...values.entries()].filter(([, ms]) => new Set(ms.map((m) => m.domain)).size >= 1);
    if (valueGroups.length >= 2) {
      // Only a conflict when the distinct values sit in different domains.
      const distinct = valueGroups.map(([v, ms]) => ({ v, domains: [...new Set(ms.map((m) => m.domain))].sort(), ms }));
      for (let i = 0; i < distinct.length; i += 1) {
        for (let j = i + 1; j < distinct.length; j += 1) {
          const A = distinct[i];
          const B = distinct[j];
          const split = A.domains.some((d) => !B.domains.includes(d)) || B.domains.some((d) => !A.domains.includes(d));
          if (!split) continue;
          if (A.ms.some((m) => B.ms.includes(m))) continue;
          out.push({
            id: `X${out.length + 1}`,
            clusterId: cluster.id,
            kind: "value",
            significance: "minor",
            topic,
            sideA: side(A.ms),
            sideB: side(B.ms),
            values: { sideA: [A.v], sideB: [B.v] },
            resolution: "not_averaged",
            note: `Sources report different concrete values (${A.v} vs ${B.v}) for the same topic. Both are listed.`,
          });
        }
      }
    }
  }

  return out;
}

/**
 * Find an assert/deny pair that contradicts the same predicate.
 *
 * The predicate is the verb the claim is about: for "is not deprecated" it is
 * "deprecat", for "does not support X" it is "support". Two claims only
 * contradict each other when those predicates line up.
 */
export function predicateOf(claim: ExtractedClaim): string | null {
  if (claim.negationCue && claim.negationCue.includes(" ... ")) {
    return claim.negationCue.split(" ... ")[1].trim().toLowerCase() || null;
  }
  const text = claim.text.toLowerCase();
  for (const cue of ["deprecat", "remov", "renam", "replac", "requir", "support", "recommend", "yank", "revert", "broken", "exist", "need"]) {
    if (text.includes(cue)) return cue;
  }
  return claim.assertionCue ? claim.assertionCue.toLowerCase() : null;
}

function opposingPair(asserts: ExtractedClaim[], denies: ExtractedClaim[]) {
  for (const d of denies) {
    const dp = predicateOf(d);
    if (!dp) continue;
    for (const a of asserts) {
      const text = a.text.toLowerCase();
      if (text.includes(dp)) return { a, d, predicate: dp };
      const ap = predicateOf(a);
      if (ap && (ap.includes(dp) || dp.includes(ap))) return { a, d, predicate: dp };
    }
  }
  return null;
}

function clusterTerms(terms: string[]): string {
  return terms.slice(0, 12).join(", ");
}

function side(claims: ExtractedClaim[]): ConflictSide {
  return {
    claimIds: claims.map((c) => c.id),
    domains: [...new Set(claims.map((c) => c.domain))].sort(),
    excerpts: claims.map((c) => ({
      claimId: c.id,
      sourceId: c.sourceId,
      url: c.sourceUrl,
      sourceClass: c.sourceClass,
      text: truncate(c.text, 300),
    })),
  };
}

const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?\b|\bDEP\d{4}\b|\bCVE-\d{4}-\d+\b/g;
const DATE_RE = /\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/g;

export function extractValues(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(VERSION_RE) ?? []) out.add(m.toLowerCase());
  for (const m of text.match(DATE_RE) ?? []) out.add(m);
  return [...out].sort();
}
