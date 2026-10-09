/**
 * Rendering a verification run for a person who directs AI and does not read
 * test reports.
 *
 * Two things are kept visibly apart, always: what the application CLAIMS (the
 * pack's descriptions) and what we DEMONSTRATED (executed actions, observed
 * values, captured files). Every line ends at an artifact path or an executed
 * action, so any claim in this report can be checked by opening a file.
 */
import type { CheckResult, VerificationRun } from "./types.ts";

const MARK: Record<string, string> = { pass: "PASS", fail: "FAIL", error: "ERROR" };

export function renderMarkdownReport(run: VerificationRun): string {
  const lines: string[] = [];
  const c = run.coverage.totals.checks;
  lines.push(`# Independent build receipt - browser verification`);
  lines.push("");
  lines.push(`- **Run id:** \`${run.run_id}\` (${run.timestamp})`);
  lines.push(`- **Requirement set:** ${run.requirement_set.set_id ?? "(none declared)"}${run.requirement_set.version ? ` v${run.requirement_set.version}` : ""} — ${run.requirement_set.source}`);
  lines.push(`- **Check pack:** \`${run.pack.id}\` v${run.pack.version} (spec ${run.pack.spec_version}, sha256 \`${run.pack.sha256.slice(0, 16)}…\`)`);
  lines.push(`- **Application under test:** ${run.app.base_url}${run.app.app_version ? ` (app version ${run.app.app_version})` : ""}`);
  lines.push(`- **Browser:** ${run.driver.label}${run.driver.executable ? ` — \`${run.driver.executable}\`` : ""} (driver \`${run.driver.id}\`, no account, no key, no network service)`);
  lines.push(`- **Executed checks:** ${c.executed} of ${c.total} — ${c.passed} passed, ${c.failed} failed, ${c.errored} could not run to completion`);
  lines.push(`- **Outcome digest:** \`${run.outcome_digest}\` (sha256 over the outcomes; the same inputs must produce this same digest)`);
  lines.push("");

  lines.push(`## Requirement coverage`);
  lines.push("");
  lines.push(`| Requirement | State | Checks bound | Executed | What that means |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const r of run.coverage.requirements) {
    lines.push(
      `| ${r.id}${r.text ? ` — ${r.text}` : ""} | **${r.state}** | ${r.check_ids.length ? r.check_ids.map((x) => `\`${x}\``).join(", ") : "none"} | ${r.executed} | ${r.note ?? ""} |`,
    );
  }
  lines.push("");
  for (const h of run.coverage.honesty) lines.push(`> ${h}`);
  lines.push("");

  lines.push(`## What was checked, and what was observed`);
  lines.push("");
  for (const check of run.checks) {
    lines.push(`### ${MARK[check.outcome]} — ${check.check_id} (requirement ${check.requirement_id})`);
    lines.push("");
    lines.push(`**What was required:** ${check.description}`);
    lines.push("");
    lines.push(`- **Outcome:** ${check.outcome}`);
    lines.push(`- **Observed:** ${check.observed ?? "(nothing was observed)"}`);
    lines.push(`- **Expected:** ${check.expected ?? "(no expectation was stated)"}`);
    lines.push(`- **Why:** ${check.detail}`);
    lines.push(`- **Evidence:** screenshot ${check.artifacts.screenshot ? `\`${check.artifacts.screenshot}\`` : "not captured"}; trace ${check.artifacts.trace ? `\`${check.artifacts.trace}\` (${check.artifacts.trace_format}, ${check.artifacts.trace_events} event(s))` : "not captured"}; evidence directory \`${check.artifacts.dir}\``);
    if (check.error) lines.push(`- **Failed step:** step ${check.error.step_index !== null ? check.error.step_index + 1 : "?"} (\`${check.error.op}\`) — ${check.error.message}`);
    lines.push(`- **Actions executed (${check.actions.length}):**`);
    for (const a of check.actions) {
      const where = a.resolved_selector ? ` on \`${a.resolved_selector}\`` : "";
      const value = a.value ? ` with ${JSON.stringify(a.value)}` : "";
      lines.push(`  ${a.index}. \`${a.op}\`${where}${value} — ${a.status}${a.error ? ` (${a.error})` : ""}`);
    }
    if (check.reads.length > 0) {
      lines.push(`- **Values read from the page:**`);
      for (const r of check.reads) {
        lines.push(`  - \`${r.name}\` = ${JSON.stringify(r.value)} (from ${r.from}${r.resolved_selector ? ` \`${r.resolved_selector}\`` : ""} at ${r.url})`);
      }
    }
    if (Object.keys(check.selectors).length > 0) {
      lines.push(`- **Selectors used:** ${Object.entries(check.selectors).map(([n, css]) => `\`${n}\` = \`${css}\``).join(", ")}`);
    }
    lines.push("");
  }

  lines.push(`## Notes`);
  lines.push("");
  for (const n of run.notes) lines.push(`- ${n}`);
  lines.push(`- Artifacts: \`${run.artifacts.run_dir}\` (run.json, report.md, coverage.json, per-check screenshots and traces).`);
  lines.push("");
  lines.push(`### How to check any line of this receipt`);
  lines.push("");
  lines.push(`1. Open \`${run.artifacts.run_json}\` — it carries the same outcome digest, the executed action list and the artifact paths for every check.`);
  lines.push(`2. Open the screenshot named on a check to see the state of the page when the claim was made.`);
  lines.push(`3. Re-run the same pack against the same app state; a different outcome digest means the app changed or the check is not deterministic.`);
  lines.push("");
  return lines.join("\n");
}

export function renderConsoleSummary(run: VerificationRun): string {
  const lines: string[] = [];
  for (const check of run.checks) {
    const mark = check.outcome.toUpperCase().padEnd(5);
    lines.push(`${mark} ${check.check_id.padEnd(28)} ${check.requirement_id.padEnd(10)} ${check.detail}`);
    if (check.artifacts.screenshot) lines.push(`      screenshot: ${check.artifacts.screenshot}`);
    if (check.artifacts.trace) lines.push(`      trace:      ${check.artifacts.trace} (${check.artifacts.trace_format})`);
  }
  lines.push("");
  lines.push(renderCoverage(run));
  return lines.join("\n");
}

export function renderCoverage(run: VerificationRun): string {
  const lines: string[] = [];
  lines.push("Requirement coverage");
  lines.push("-------------------");
  for (const r of run.coverage.requirements) {
    const bound = r.check_ids.length ? r.check_ids.join(",") : "-";
    lines.push(`${r.state.padEnd(11)} ${r.id.padEnd(12)} checks:[${bound}] executed:${r.executed}  ${r.text ?? ""}`);
  }
  const t = run.coverage.totals;
  lines.push("");
  lines.push(
    `requirements: ${t.requirements} — passed ${t.passed}, failed ${t.failed}, error ${t.errored}, UNVERIFIED ${t.unverified}`,
  );
  lines.push(
    `checks: ${t.checks.executed}/${t.checks.total} executed (${t.checks.selected} selected) — passed ${t.checks.passed}, failed ${t.checks.failed}, error ${t.checks.errored}`,
  );
  for (const h of run.coverage.honesty) lines.push(`> ${h}`);
  return lines.join("\n");
}

export function summarizeCheck(check: CheckResult): string {
  return `${check.check_id} [${check.outcome}] req=${check.requirement_id}`;
}
