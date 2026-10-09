import type { LedgerEntry } from "../types.ts";
import { truncate } from "../util/text.ts";

export interface RenderOptions {
  runCommand: string;
  ledger?: { backend: string; location: string | null };
}

export function renderMarkdown(entry: LedgerEntry, opts: RenderOptions): string {
  const lines: string[] = [];
  const conf = entry.verdict.confidence;

  lines.push(`# Aletheia research report`);
  lines.push("");
  lines.push(`**Question.** ${entry.question}`);
  lines.push("");
  lines.push(
    `\`run id ${entry.runId}\`  ·  \`${entry.timestamp}\`  ·  rubric \`${entry.rubric.id}@${entry.rubric.version}\` (sha256 \`${entry.rubric.sha256.slice(0, 16)}…\`)  ·  engine \`${entry.engineVersion}\``,
  );
  lines.push("");

  // ---- verdict ----------------------------------------------------------
  lines.push(`## Verdict`);
  lines.push("");
  lines.push(`**${entry.verdict.answerSummary}**`);
  lines.push("");
  lines.push(entry.verdict.text);
  lines.push("");

  // ---- confidence -------------------------------------------------------
  lines.push(`## Confidence: ${conf.level} (\`${conf.score}\`)`);
  lines.push("");
  lines.push("```");
  lines.push(conf.formula);
  lines.push(conf.explanation);
  lines.push("```");
  lines.push("");
  lines.push("| Confidence input | Value |");
  lines.push("| --- | --- |");
  for (const [k, v] of Object.entries(conf.inputs)) {
    lines.push(`| \`${k}\` | ${typeof v === "object" ? JSON.stringify(v) : String(v)} |`);
  }
  lines.push("");

  // ---- dissent ----------------------------------------------------------
  lines.push(`## Dissent, conflicts and gaps`);
  lines.push("");
  if (entry.verdict.dissent.length === 0) {
    lines.push("Nothing retrieved contradicted the position above. Absence of dissent is not proof of correctness.");
  } else {
    for (const d of entry.verdict.dissent) {
      lines.push(`- **${d.kind.replace(/_/g, " ")}** — ${d.summary}${d.sources?.length ? ` _(sources: ${d.sources.join(", ")})_` : ""}`);
    }
  }
  lines.push("");

  if (entry.conflicts.length > 0) {
    lines.push(`## Conflicts (surfaced, never averaged)`);
    lines.push("");
    for (const c of entry.conflicts) {
      lines.push(`### ${c.id} — ${c.kind === "polarity" ? "direct contradiction" : "conflicting values"} (${c.significance})`);
      lines.push("");
      lines.push(`Topic: ${c.topic}`);
      lines.push("");
      lines.push(`- **Side A** (${c.sideA.domains.join(", ") || "unknown"}) — claims ${c.sideA.claimIds.join(", ")}${c.values ? ` — values: ${c.values.sideA.join(", ")}` : ""}`);
      for (const ex of c.sideA.excerpts.slice(0, 3)) lines.push(`  - \`${ex.sourceId}\` (${ex.sourceClass.replace(/_/g, " ")}): ${truncate(ex.text, 260)}`);
      lines.push(`- **Side B** (${c.sideB.domains.join(", ") || "unknown"}) — claims ${c.sideB.claimIds.join(", ")}${c.values ? ` — values: ${c.values.sideB.join(", ")}` : ""}`);
      for (const ex of c.sideB.excerpts.slice(0, 3)) lines.push(`  - \`${ex.sourceId}\` (${ex.sourceClass.replace(/_/g, " ")}): ${truncate(ex.text, 260)}`);
      lines.push("");
      lines.push(`_Resolution policy: \`${c.resolution}\` — ${c.note}_`);
      lines.push("");
    }
  }

  // ---- scoring appendix --------------------------------------------------
  lines.push(`## Scoring appendix (recompute by hand)`);
  lines.push("");
  lines.push(
    `Total = Σ (dimension weight × dimension score), rounded to 4 dp. Rubric \`${entry.rubric.id}@${entry.rubric.version}\`; the file is stored with the code so every weight below is checkable.`,
  );
  lines.push("");
  const claimById = new Map(entry.claims.map((c) => [c.id, c]));
  const ranked = [...entry.scores].sort((a, b) => b.total - a.total).slice(0, 12);
  lines.push("| claim | source | class | total | sourceClass | corroboration | recency | specificity |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const score of ranked) {
    const claim = claimById.get(score.claimId);
    const dim = (name: string) => score.dimensions.find((d) => d.dimension === name);
    const cell = (name: string) => {
      const d = dim(name);
      return d ? `${d.score} (w${d.weight})` : "—";
    };
    lines.push(
      `| \`${score.claimId}\` | \`${claim?.sourceId ?? "?"}\` | ${claim?.sourceClass.replace(/_/g, " ") ?? "—"} | **${score.total}** | ${cell("sourceClass")} | ${cell("corroboration")} | ${cell("recency")} | ${cell("specificity")} |`,
    );
  }
  lines.push("");
  lines.push("<details><summary>Raw inputs behind the top 5 scores</summary>");
  lines.push("");
  for (const score of ranked.slice(0, 5)) {
    lines.push(`**\`${score.claimId}\`** — total \`${score.total}\``);
    lines.push("");
    for (const d of score.dimensions) {
      lines.push(`- \`${d.dimension}\` score \`${d.score}\` × weight \`${d.weight}\` = \`${d.contribution}\` — ${d.explanation}`);
      lines.push(`  - inputs: \`${JSON.stringify(d.rawInputs)}\``);
    }
    lines.push("");
  }
  lines.push("</details>");
  lines.push("");

  // ---- retrieval status --------------------------------------------------
  lines.push(`## Retrieval paths`);
  lines.push("");
  lines.push("| adapter | status | sources | note |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of entry.retrieval) {
    lines.push(
      `| \`${r.adapter}\` | ${r.status}${r.reasonCode ? ` (\`${r.reasonCode}\`)` : ""} | ${r.docCount} | ${r.reason ? escapePipes(truncate(r.reason, 200)) : "—"} |`,
    );
  }
  lines.push("");
  const degraded = entry.retrieval.filter((r) => r.status !== "ok");
  if (degraded.length > 0) {
    lines.push(`Paths that did not contribute cleanly: ${degraded.map((d) => `\`${d.adapter}\``).join(", ")}. The run completed on the paths that answered.`);
    lines.push("");
  }

  // ---- sources -----------------------------------------------------------
  lines.push(`## Sources`);
  lines.push("");
  lines.push("| id | class | path | published | url |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const s of entry.sources) {
    lines.push(
      `| \`${s.id}\` | ${s.sourceClass.replace(/_/g, " ")} (\`${s.sourceClassRule}\`) | ${s.retrievalPath}/${s.retrievalDetail} | ${s.publishedAt ? s.publishedAt.slice(0, 10) : `unknown (${s.dateSource})`} | ${s.url} |`,
    );
  }
  lines.push("");
  if (entry.sources.length === 0) {
    lines.push("_No source was retrieved. Nothing in this report is supported by evidence._");
    lines.push("");
  }

  // ---- claims ------------------------------------------------------------
  lines.push(`## Extracted claims`);
  lines.push("");
  lines.push(`| claim | source | polarity | overlap | text |`);
  lines.push("| --- | --- | --- | --- | --- |");
  for (const c of entry.claims.slice(0, 60)) {
    lines.push(`| \`${c.id}\` | \`${c.sourceId}\` | ${c.polarity}${c.negationCue ? ` (${c.negationCue})` : ""} | ${c.questionOverlap} | ${escapePipes(truncate(c.text, 220))} |`);
  }
  lines.push("");

  // ---- reproducibility ---------------------------------------------------
  lines.push(`## Reproduce this run`);
  lines.push("");
  lines.push("```sh");
  lines.push(opts.runCommand);
  lines.push("```");
  lines.push("");
  if (opts.ledger) {
    lines.push(
      `Appended to the **${opts.ledger.backend}** ledger at \`${opts.ledger.location ?? "unknown"}\` as \`${entry.runId}\`. Entry hash \`${entry.hash || "(computed on append)"}\`.`,
    );
  } else {
    lines.push("This run was not written to a ledger (`--no-ledger` or the ledger failed to open).");
  }
  lines.push("");
  lines.push(
    `The ledger is append-only: this entry can never be edited or deleted. A correction is a new entry that supersedes \`${entry.runId}\`.`,
  );
  lines.push("");

  // ---- methodology -------------------------------------------------------
  lines.push(`## How this report was produced`);
  lines.push("");
  lines.push(`- **Reasoning adapter:** \`${entry.verdict.reasoningAdapter}\` (mode \`${entry.verdict.reasoningMode}\`; the only reasoner, deterministic, no model in the pipeline).`);
  for (const caveat of entry.verdict.caveats) lines.push(`  - ${caveat}`);
  lines.push(`- **Scoring:** rubric \`${entry.rubric.id}@${entry.rubric.version}\` (sha256 \`${entry.rubric.sha256}\`), stored as data at \`rubric/v1.json\`. Every score in the appendix lists the raw inputs that produced it.`);
  lines.push(`- **Conflicts:** policy \`surface_never_average\` — opposing claims are reported side by side and are never combined into one number.`);
  lines.push(`- **Provider independence:** ${entry.retrieval.map((r) => `\`${r.adapter}\`(${r.status})`).join(", ")}.`);
  lines.push("");
  lines.push("_Provider configuration for this run:_");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(entry.providerConfig, null, 2));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
