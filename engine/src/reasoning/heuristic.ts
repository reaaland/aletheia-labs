import type { ClaimCluster, Dissent, ExtractedClaim, GroupScore, ReasoningAdapter, ReasoningRequest, ReasoningResult, Rubric, SourceDoc } from "../types.ts";
import { truncate } from "../util/text.ts";

/**
 * The deterministic, credential-free reasoner.
 *
 * It extracts nothing (extraction already happened in grade/extract.ts) and it
 * decides nothing about confidence (that is grade/confidence.ts). Its whole job
 * is to turn the graded evidence into readable prose with citations, using
 * fixed templates. Same input -> byte-identical output, forever, with no
 * network and no key. This is what makes the pipeline runnable end to end at
 * zero cost, and it is the only reasoner the engine has.
 */
export const heuristicReasoner: ReasoningAdapter = {
  layer: "reasoning",
  id: "heuristic",
  label: "Deterministic template reasoner",
  description:
    "No model, no network, no key. Writes the verdict from fixed templates over the graded evidence and quotes the dissent verbatim.",
  configKeys: [],
  deterministic: true,
  available(): boolean {
    return true;
  },
  async synthesize(req: ReasoningRequest): Promise<ReasoningResult> {
    const started = Date.now();
    return {
      verdict: renderVerdict(req),
      answerSummary: renderAnswerSummary(req),
      mode: "deterministic_template",
      caveats: [
        "The verdict prose was produced by the deterministic template reasoner, not by a language model. Wording is mechanical; every sentence maps to a scored claim.",
        "Confidence was computed from the rubric, not asserted by the reasoner.",
      ],
      adapterId: this.id,
      adapterLabel: this.label,
      durationMs: Date.now() - started,
    };
  },
};

export function citationFor(source: SourceDoc): string {
  return `[${source.id}]`;
}

function claimIndex(req: ReasoningRequest): Map<string, ExtractedClaim> {
  return new Map(req.claims.map((c) => [c.id, c]));
}

function sourceIndex(req: ReasoningRequest): Map<string, SourceDoc> {
  return new Map(req.sources.map((s) => [s.id, s]));
}

function renderAnswerSummary(req: ReasoningRequest): string {
  const primary = req.groups[0];
  if (!primary) {
    return "No claim in the retrieved evidence could be scored, so the engine cannot answer this question.";
  }
  const claims = claimIndex(req);
  const lead = primary.claimIds.map((id) => claims.get(id)).filter(Boolean) as ExtractedClaim[];
  const best = lead.sort((a, b) => b.questionOverlap - a.questionOverlap)[0];
  const stance = primary.polarity === "deny" ? "The evidence contradicts" : "The evidence supports";
  return best ? `${stance}: ${truncate(best.text, 240)}` : "Evidence was graded but no lead claim was selected.";
}

function renderVerdict(req: ReasoningRequest): string {
  const { question, groups, clusters, conflicts, confidence, sources, outcomes } = req;
  const claims = claimIndex(req);
  const bySource = sourceIndex(req);
  const rubric = req.rubric;
  const maxClaims = rubric.reporting.maxClaimsPerGroup;

  const lines: string[] = [];
  const primary = groups[0] ?? null;
  const parts = question.split(/\?/).filter((p) => p.trim().length > 0);
  const subQuestions = parts.length > 1 ? parts.map((p) => p.trim()) : [question];

  if (!primary) {
    lines.push("There is not enough retrieved evidence to state a position. See the retrieval status below.");
    return lines.join("\n");
  }

  // --- what the evidence establishes -------------------------------------
  lines.push(`### What the evidence establishes (${primary.polarity === "deny" ? "against" : "for"} the proposition)`);
  lines.push("");
  const lead = primary.claimIds
    .map((id) => claims.get(id))
    .filter(Boolean)
    .sort((a, b) => b.questionOverlap - a.questionOverlap || a.id.localeCompare(b.id, "en", { numeric: true }))
    .slice(0, maxClaims) as ExtractedClaim[];
  for (const claim of lead) {
    const src = bySource.get(claim.sourceId);
    const scoreEntry = primary.claimScores.find((s) => s.claimId === claim.id);
    lines.push(
      `- ${truncate(claim.text, 400)} ${src ? citationFor(src) : ""}${
        scoreEntry ? ` _(score ${scoreEntry.total}, ${claim.sourceClass.replace(/_/g, " ")})_` : ""
      }`,
    );
  }
  lines.push("");

  // --- replacement / mitigation ------------------------------------------
  const replacement = findReplacementClaims(req);
  if (replacement.length > 0) {
    lines.push("### Stated replacement or mitigation");
    lines.push("");
    for (const claim of replacement) {
      const src = bySource.get(claim.sourceId);
      lines.push(`- ${truncate(claim.text, 360)} ${src ? citationFor(src) : ""}`);
    }
    lines.push("");
  }

  // --- per sub-question answers ------------------------------------------
  if (subQuestions.length > 1) {
    lines.push("### Per-part answer");
    lines.push("");
    for (const sq of subQuestions) {
      const topical = clusters
        .map((c) => ({ cluster: c, overlap: overlapWith(sq, c, claims, rubric) }))
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 2);
      if (topical.length === 0) {
        lines.push(`- **${truncate(sq, 120)}** - no retrieved evidence addressed this part.`);
        continue;
      }
      const pick = topical[0];
      const memberClaims = pick.cluster.claimIds.map((id) => claims.get(id)).filter(Boolean) as ExtractedClaim[];
      const best = memberClaims.sort((a, b) => b.questionOverlap - a.questionOverlap)[0];
      const group = groups.find((g) => g.clusterId === pick.cluster.id);
      const src = best ? bySource.get(best.sourceId) : undefined;
      lines.push(
        `- **${truncate(sq, 120)}** - ${best ? `${truncate(best.text, 260)} ${src ? citationFor(src) : ""}` : "no claim selected"}${
          group ? ` _(rated ${group.score})_` : ""
        }`,
      );
    }
    lines.push("");
  }

  // --- dissent ------------------------------------------------------------
  lines.push("### Dissent and conflicts");
  lines.push("");
  const dissentGroups = groups.filter((g) => g.clusterId === primary.clusterId && g.polarity !== primary.polarity);
  if (conflicts.length === 0 && dissentGroups.length === 0) {
    lines.push(
      "No source in the retrieved evidence contradicted the position above. Absence of dissent is not proof: it means nothing that was retrieved disagreed.",
    );
    lines.push("");
  }
  for (const conflict of conflicts) {
    lines.push(
      `- **${conflict.kind === "polarity" ? "Direct contradiction" : "Conflicting values"}** (\`${conflict.id}\`, cluster \`${conflict.clusterId}\`, ${conflict.significance}): ${conflict.topic}`,
    );
    lines.push(`  - Side A (${conflict.sideA.domains.join(", ") || "unknown"}): ${truncate(conflict.sideA.excerpts[0]?.text ?? "", 300)}`);
    lines.push(`  - Side B (${conflict.sideB.domains.join(", ") || "unknown"}): ${truncate(conflict.sideB.excerpts[0]?.text ?? "", 300)}`);
    lines.push(`  - Not averaged: ${conflict.note}`);
  }
  for (const g of dissentGroups) {
    const sample = g.claimIds.map((id) => claims.get(id)).filter(Boolean)[0] as ExtractedClaim | undefined;
    const src = sample ? bySource.get(sample.sourceId) : undefined;
    lines.push(
      `- **Opposing cluster rated ${g.score}** (${g.independentDomains.join(", ")}): ${sample ? truncate(sample.text, 300) : ""} ${src ? citationFor(src) : ""}`,
    );
  }
  const unavailable = outcomes.filter((o) => o.status === "unavailable" || o.status === "failed");
  for (const o of unavailable) {
    lines.push(`- **Retrieval path unavailable** \`${o.adapter}\`: ${o.reasonCode ?? "error"} - ${o.reason}`);
  }
  lines.push("");

  // --- confidence ---------------------------------------------------------
  lines.push(`### Confidence: ${confidence.level} (${confidence.score})`);
  lines.push("");
  lines.push(`\`${confidence.formula}\``);
  lines.push("");
  lines.push(confidence.explanation);
  lines.push("");
  lines.push(
    `Computed by the engine from the rubric, not asserted by the reasoner. Inputs are recorded in the ledger so this number can be recomputed by hand.`,
  );

  return lines.join("\n");
}

function overlapWith(question: string, cluster: ClaimCluster, claims: Map<string, ExtractedClaim>, rubric: Rubric): number {
  const qTerms = new Set(question.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []);
  let best = 0;
  for (const id of cluster.claimIds) {
    const claim = claims.get(id);
    if (!claim) continue;
    const cTerms = new Set(claim.text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []);
    let shared = 0;
    for (const t of qTerms) if (cTerms.has(t) && !rubric.clustering.stopwords.includes(t)) shared += 1;
    best = Math.max(best, shared);
  }
  return best;
}

const REPLACEMENT_CUES = [
  "instead of",
  "replace",
  "replacement",
  "in favour of",
  "in favor of",
  "use ",
  "migrate",
  "switch to",
  "recommend",
  "userland alternative",
  "alternative",
];

export function findReplacementClaims(req: ReasoningRequest): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const cluster of req.clusters) {
    for (const id of cluster.claimIds) {
      const claim = req.claims.find((c) => c.id === id);
      if (!claim) continue;
      const lower = claim.text.toLowerCase();
      if (!REPLACEMENT_CUES.some((cue) => lower.includes(cue))) continue;
      if (seen.has(claim.id)) continue;
      seen.add(claim.id);
      out.push(claim);
    }
  }
  return out
    .sort((a, b) => b.questionOverlap - a.questionOverlap || b.matchedSignals.length - a.matchedSignals.length || a.id.localeCompare(b.id, "en", { numeric: true }))
    .slice(0, 3);
}

export function buildDissent(req: ReasoningRequest): Dissent[] {
  const out: Dissent[] = [];
  for (const conflict of req.conflicts) {
    out.push({
      kind: "conflict",
      summary: `${conflict.kind === "polarity" ? "Direct contradiction" : "Conflicting values"} on cluster ${conflict.clusterId}: ${conflict.topic}. Not averaged.`,
      claimIds: [...conflict.sideA.claimIds, ...conflict.sideB.claimIds],
      sources: [...conflict.sideA.domains, ...conflict.sideB.domains],
    });
  }
  for (const o of req.outcomes) {
    if (o.status === "unavailable" || o.status === "failed") {
      out.push({
        kind: "unavailable_provider",
        summary: `Retrieval path "${o.adapter}" did not contribute: ${o.reasonCode ?? "error"} - ${o.reason}`,
      });
    }
  }
  if (req.confidence.level === "low" || req.confidence.level === "very_low") {
    out.push({
      kind: "weak_evidence",
      summary: `Confidence is ${req.confidence.level} (${req.confidence.score}). Treat the position above as provisional.`,
    });
  }
  const primary = req.groups[0];
  if (primary) {
    const opposing = req.groups.filter((g) => g.clusterId === primary.clusterId && g.polarity !== primary.polarity);
    for (const g of opposing) {
      out.push({
        kind: "conflict",
        summary: `An opposing cluster on the same topic was rated ${g.score} from ${g.independentDomains.join(", ")}.`,
        claimIds: g.claimIds,
        sources: g.independentDomains,
      });
    }
  }
  return out;
}

export { type GroupScore };
