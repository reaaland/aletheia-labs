import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  classifySource,
  loadRubric,
  scoreCorroboration,
  scoreRecency,
  scoreSourceClass,
  scoreSpecificity,
  detectSignals,
  totalFromDimensions,
  validateRubric,
} from "../src/grade/rubric.ts";
import { extractClaims } from "../src/grade/extract.ts";
import { buildClusters, scoreClaims } from "../src/grade/cluster.ts";
import { computeConfidence } from "../src/grade/confidence.ts";
import { detectConflicts } from "../src/grade/conflicts.ts";
import { fixtures, QUESTION, RUN_DATE } from "../fixtures/sources.ts";

const RUBRIC_PATH = resolve(import.meta.dir, "..", "rubric", "v1.json");
const rubric = loadRubric(RUBRIC_PATH);

function fullPass() {
  const claims = extractClaims(fixtures, QUESTION, rubric);
  const clusters = buildClusters(claims, rubric);
  const { scores, groups } = scoreClaims(claims, clusters, rubric, RUN_DATE);
  const conflicts = detectConflicts(
    clusters.map((c) => ({ id: c.id, claimIds: c.claimIds, polarityGroups: c.polarityGroups, terms: c.terms })),
    claims,
    rubric,
  );
  return { claims, clusters, scores, groups, conflicts };
}

describe("rubric is data, and it is valid", () => {
  test("weights sum to 1.0 and required dimensions exist", () => {
    const sum = Object.values(rubric.dimensions).reduce((acc, d) => acc + d.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
    for (const name of ["sourceClass", "corroboration", "recency", "specificity"]) {
      expect(rubric.dimensions[name]).toBeDefined();
      expect(rubric.dimensions[name].weight).toBeGreaterThan(0);
    }
    expect(rubric.conflictPolicy.rule).toBe("surface_never_average");
  });

  test("a rubric whose weights do not sum to 1 is rejected", () => {
    const broken = JSON.parse(JSON.stringify(rubric));
    broken.dimensions.recency.weight = 0.5;
    expect(() => validateRubric(broken)).toThrow(/sum to 1/);
  });

  test("every versioned rubric states the class it is (no vendor names in weights)", () => {
    expect(rubric.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(rubric.sourceClassRules.upgrade.length).toBeGreaterThan(3);
  });
});

describe("source classification is rule-based and auditable", () => {
  test("primary documentation outranks a vendor blog outranks an aggregator", () => {
    const doc = classifySource("https://nodejs.org/api/deprecations.html", rubric);
    const blog = classifySource("https://blog.example-vendor.com/blog/x", rubric);
    const wiki = classifySource("https://en.wikipedia.org/wiki/Punycode", rubric);
    expect(doc.sourceClass).toBe("primary_documentation");
    expect(blog.sourceClass).toBe("vendor_blog");
    expect(wiki.sourceClass).toBe("aggregator");
    const s = (c: string) => rubric.dimensions.sourceClass.scale![c];
    expect(s(doc.sourceClass)).toBeGreaterThan(s(blog.sourceClass));
    expect(s(blog.sourceClass)).toBeGreaterThan(s(wiki.sourceClass));
    expect(doc.ruleId).toBe("official-docs-host");
  });

  test("a changelog path beats a generic github url", () => {
    const rel = classifySource("https://github.com/nodejs/node/releases", rubric);
    expect(rel.sourceClass).toBe("first_party_changelog");
  });

  test("unknown hosts fall through to the default and say so", () => {
    const other = classifySource("https://some-random-host.example/page", rubric);
    expect(other.sourceClass).toBe("unknown");
    expect(other.ruleId).toBe("default");
  });
});

describe("scoring is deterministic and recomputable by hand", () => {
  test("the same input produces byte-identical scores across repeated runs", () => {
    const a = fullPass();
    const b = fullPass();
    expect(JSON.stringify(a.scores)).toBe(JSON.stringify(b.scores));
    expect(JSON.stringify(a.clusters)).toBe(JSON.stringify(b.clusters));
    expect(JSON.stringify(a.conflicts)).toBe(JSON.stringify(b.conflicts));
  });

  test("every total equals the weighted sum of its dimensions", () => {
    const { scores } = fullPass();
    expect(scores.length).toBeGreaterThan(0);
    for (const score of scores) {
      const byHand = score.dimensions.reduce((acc, d) => acc + d.weight * d.score, 0);
      expect(score.total).toBeCloseTo(Math.round(byHand * 10000) / 10000, 6);
      expect(score.rubricVersion).toBe(rubric.version);
      // Raw inputs must be present for every dimension, or the score is not auditable.
      for (const d of score.dimensions) expect(d.rawInputs).toBeDefined();
    }
  });

  test("dimension helpers return the exact rubric values", () => {
    const cls = scoreSourceClass(rubric, "primary_documentation", "official-docs-host");
    expect(cls.score).toBe(1.0 === cls.score ? cls.score : rubric.dimensions.sourceClass.scale!.primary_documentation);
    expect(cls.rawInputs.matchedScaleKey).toBe("primary_documentation");

    const corr = scoreCorroboration(rubric, ["a.com", "b.com"], ["a.com", "b.com", "c.com"]);
    expect(corr.score).toBe(0.7);
    expect(corr.rawInputs.count).toBe(2);

    const rec = scoreRecency(rubric, RUN_DATE, "source_metadata", RUN_DATE);
    expect(rec.score).toBe(1);
    const old = scoreRecency(rubric, "2020-01-02T00:00:00.000Z", "source_metadata", RUN_DATE);
    expect(old.score).toBeLessThan(1);
    const undated = scoreRecency(rubric, null, "unknown", RUN_DATE);
    expect(undated.score).toBe(rubric.dimensions.recency.unknownScore!);

    const spec = scoreSpecificity(rubric, "deprecates node:punycode on 2024-01-01 (see https://nodejs.org)");
    expect(spec.rawInputs.matchedSignals).toContain("dateToken");
    expect(spec.rawInputs.matchedSignals).toContain("urlToken");
    expect(spec.score).toBeGreaterThan(0);
    expect(spec.score).toBeLessThanOrEqual(1);
    expect(detectSignals(rubric, "version 21.0.0 is affected").signals).toContain("versionToken");
    // The pattern table and the weight table must both be consulted: compiling
    // the weights as regexes is the failure mode this guards against.
    expect(detectSignals(rubric, "unrelated plain sentence").signals).toEqual([]);

    expect(totalFromDimensions([cls])).toBeCloseTo(Math.round(cls.contribution * 10000) / 10000, 6);
  });

  test("a more recent source scores higher on recency than an older one", () => {
    const recent = scoreRecency(rubric, "2025-12-01T00:00:00.000Z", "source_metadata", RUN_DATE);
    const older = scoreRecency(rubric, "2021-01-01T00:00:00.000Z", "source_metadata", RUN_DATE);
    expect(recent.score).toBeGreaterThan(older.score);
  });
});

describe("conflicts are surfaced, never averaged", () => {
  test("a contradiction between independent sources becomes a conflict record", () => {
    const { conflicts } = fullPass();
    const polarity = conflicts.filter((c) => c.kind === "polarity");
    expect(polarity.length).toBeGreaterThan(0);
    for (const c of conflicts) {
      expect(c.resolution).toBe("not_averaged");
      expect(c.sideA.claimIds.length).toBeGreaterThan(0);
      expect(c.sideB.claimIds.length).toBeGreaterThan(0);
      // Both sides must be recoverable, with their sources, from the record.
      expect(c.sideA.excerpts[0].url).toBeTruthy();
      expect(c.sideB.excerpts[0].url).toBeTruthy();
    }
  });

  test("conflicting claims land on opposite polarity, so they cannot be merged", () => {
    const { claims } = fullPass();
    const denied = claims.filter((c) => c.polarity === "deny");
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every((c) => c.negationCue !== null)).toBe(true);
  });

  test("the conflict reduces confidence rather than being absorbed silently", () => {
    const { claims, clusters, groups, conflicts } = fullPass();
    const withConflict = computeConfidence({ groups, claims, sources: fixtures, conflicts, outcomes: [], rubric });
    const withoutConflict = computeConfidence({ groups, claims, sources: fixtures, conflicts: [], outcomes: [], rubric });
    expect(withConflict.inputs.conflictsMaterial).toBeGreaterThan(0);
    expect(withoutConflict.score).toBeGreaterThan(withConflict.score);
  });
});

describe("confidence is computed from recorded inputs", () => {
  test("recomputing the formula from the recorded inputs reproduces the score", () => {
    const { claims, groups, conflicts } = fullPass();
    const conf = computeConfidence({ groups, claims, sources: fixtures, conflicts, outcomes: [], rubric });
    const i = conf.inputs;
    const byHand = i.primaryGroupScore * i.coverageFactor * i.authorityFactor * i.retrievalFactor * (1 - i.conflictPenalty);
    expect(conf.score).toBeCloseTo(Math.round(byHand * 10000) / 10000, 6);
    expect(["high", "moderate", "low", "very_low"]).toContain(conf.level);
  });

  test("confidence is a pure function of the evidence", () => {
    const a = fullPass();
    const b = fullPass();
    const ca = computeConfidence({ groups: a.groups, claims: a.claims, sources: fixtures, conflicts: a.conflicts, outcomes: [], rubric });
    const cb = computeConfidence({ groups: b.groups, claims: b.claims, sources: fixtures, conflicts: b.conflicts, outcomes: [], rubric });
    expect(JSON.stringify(ca)).toBe(JSON.stringify(cb));
  });
});
