import type { ExtractedClaim, Rubric, SourceDoc } from "../types.ts";
import { splitSentences, significantTerms, stripMarkdown, truncate, domainOf } from "../util/text.ts";

/**
 * Deterministic claim extraction. No model, no network, no credentials.
 *
 * Output is a list of candidate propositions: sentence-level spans that contain
 * at least one assertion cue or a hard identifier (version, CVE, DEP number),
 * long enough to be checkable, and not page chrome. Polarity is a separate,
 * explicit field so two sources disagreeing produce two opposing claims rather
 * than one mush.
 */
export function extractClaims(sources: SourceDoc[], question: string, rubric: Rubric): ExtractedClaim[] {
  const stop = new Set(rubric.clustering.stopwords.map((s) => s.toLowerCase()));
  const questionTerms = new Set(significantTerms(stripMarkdown(question), stop));
  const assertionCues = rubric.claimExtraction.assertionCues.map((c) => c.toLowerCase());
  const negationCues = rubric.claimExtraction.negationCues.map((c) => c.toLowerCase());
  const signalPatterns = rubric.claimExtraction.specificitySignals;
  const boilerplate = (rubric.claimExtraction.boilerplateCues ?? []).map((c) => c.toLowerCase());

  const claims: ExtractedClaim[] = [];
  for (const source of sources) {
    const body = stripMarkdown(source.text);
    const sentences = splitSentences(body);
    const seen = new Set<string>();
    let index = 0;
    for (const sentence of sentences) {
      const text = sentence.trim();
      if (text.length < rubric.clustering.minCharsPerClaim) continue;
      if (isBoilerplate(text, boilerplate)) continue;
      const tokens = significantTerms(text, stop);
      if (tokens.length < rubric.clustering.minTokensPerClaim) continue;
      const lower = text.toLowerCase();
      const assertionCue = assertionCues.find((c) => lower.includes(c)) ?? null;
      const matchedSignals = Object.entries(signalPatterns)
        .filter(([, pattern]) => new RegExp(pattern, "i").test(text))
        .map(([name]) => name);
      const hardIdentifier = matchedSignals.includes("versionToken") || matchedSignals.includes("identifierToken");
      if (!assertionCue && !hardIdentifier) continue;
      const overlap = overlapFraction(questionTerms, new Set(tokens));
      if (overlap === 0 && matchedSignals.length === 0) continue;

      const dedupeKey = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const negationCue = findNegationCue(lower, negationCues, assertionCue);
      index += 1;
      claims.push({
        id: `${source.id}-C${index}`,
        sourceId: source.id,
        sourceUrl: source.url,
        retrievalPath: source.retrievalPath,
        retrievalDetail: source.retrievalDetail,
        sourceClass: source.sourceClass,
        sourceClassRule: source.sourceClassRule,
        domain: domainOf(source.url),
        publishedAt: source.publishedAt,
        text: truncate(text, 600),
        polarity: negationCue ? "deny" : "assert",
        negationCue,
        assertionCue,
        matchedSignals: matchedSignals.sort(),
        termCount: tokens.length,
        questionOverlap: Number(overlap.toFixed(4)),
      });
    }
  }

  claims.sort((a, b) =>
    a.sourceId === b.sourceId
      ? a.id.localeCompare(b.id, "en", { numeric: true })
      : a.sourceId.localeCompare(b.sourceId, "en", { numeric: true }),
  );
  return claims;
}

/** Page chrome, licence footers and navigation must never become evidence. */
export function isBoilerplate(text: string, cues: string[]): boolean {
  const lower = text.toLowerCase();
  if (cues.some((cue) => lower.includes(cue))) return true;
  // Link/nav soup: lots of very short capitalised fragments.
  const words = text.split(/\s+/);
  const shortCapitalised = words.filter((w) => /^[A-Z][a-z]{0,4}$/.test(w)).length;
  if (words.length > 25 && shortCapitalised / words.length > 0.45) return true;
  return false;
}

/**
 * A claim is a denial when it contains an explicit negation cue, or when a
 * negator sits within a short window before the thing being asserted
 * ("does not mark ... as deprecated", "no longer required"). The matched cue is
 * recorded on the claim so a reader can see exactly why polarity was assigned.
 */
export function findNegationCue(lower: string, negationCues: string[], assertionCue: string | null): string | null {
  const direct = negationCues.find((c) => new RegExp(c, "i").test(lower));
  if (direct) return direct;
  const window = /\b(not|no|never|without|cannot|can't|won't|isn't|aren't|doesn't|don't|didn't|hasn't|haven't)(?:\s+\w+){0,5}\s+(deprecat|remov|requir|support|yank|recommend|replac|revert|broken|available|exist|need)/i.exec(
    lower,
  );
  if (window) return `${window[1]} ... ${window[2]}`;
  if (assertionCue && /(myth|rumou?r|falsely|incorrect|not true|no longer applie)/i.test(lower)) {
    return /(myth|rumou?r|falsely|incorrect|not true|no longer applie)/i.exec(lower)![0].toLowerCase();
  }
  return null;
}

export function overlapFraction(questionTerms: Set<string>, claimTerms: Set<string>): number {
  if (questionTerms.size === 0) return 0;
  let n = 0;
  for (const t of questionTerms) if (claimTerms.has(t)) n += 1;
  return n / questionTerms.size;
}
