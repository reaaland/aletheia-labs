#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, DEFAULT_DB_PATH, DEFAULT_RUBRIC_PATH } from "./config.ts";
import { runResearch } from "./pipeline.ts";
import { openLedger } from "./ledger/index.ts";
import { loadRubric } from "./grade/rubric.ts";
import { describeAdapters } from "./retrieval/index.ts";
import { allReasoningAdapters } from "./reasoning/index.ts";
import { ENGINE_VERSION } from "./util/ids.ts";
import { describeBrowserDrivers, verifyWebApp } from "./browser/index.ts";
import type { Env } from "./types.ts";

const HELP = `aletheia-engine ${ENGINE_VERSION} - provider-agnostic research core

USAGE
  bun run research "<question>" [options]
  bun run research ledger list [n]
  bun run research ledger show <runId>
  bun run research ledger verifications [n]
  bun run research ledger show-verification <runId>
  bun run research ledger verify
  bun run research adapters
  bun run research browser drivers
  bun run research browser run --pack <file> [options]
  bun run research rubric

OPTIONS
  --source <url>         Add a URL to fetch directly. Repeatable. This path needs no key.
  --json                 Print the machine-readable report (the ledger entry) instead of Markdown.
  --out <file>           Also write the Markdown report to a file.
  --db <path>            Ledger file (default ${DEFAULT_DB_PATH}; env ALETHEIA_DB).
  --rubric <path>        Rubric data file (default ${DEFAULT_RUBRIC_PATH}; env ALETHEIA_RUBRIC).
  --retrieval <ids>      Comma-separated retrieval adapters to use (default: all).
  --max-sources <n>      Cap on merged sources (default 24).
  --per-adapter <n>      Cap on sources per adapter (default 5).
  --timeout <ms>         Per-request timeout (default 12000).
  --offline              Disable every network path (no adapter can reach out).
  --no-ledger            Do not write to the ledger.
  --quiet                Suppress progress notes on stderr.

BROWSER VERIFICATION (real browser, local, zero cost)
  bun run research browser run --pack checks/mypack.json [--base-url <url>]
      --pack <file>          The versioned check pack (JSON) to execute.
      --base-url <url>       Override the pack's base_url.
      --requirements <file>  An approved requirement set, so requirements with
                             no check are reported UNVERIFIED in the coverage report.
      --artifacts <dir>      Where screenshots, traces and the run record go
                             (default ${join("artifacts", "browser")} next to the ledger).
      --browser <id>         playwright | cdp | auto (default auto: try each).
      --only <ids>           Comma-separated check ids to run (the rest are reported
                             as not executed, never as passed).
      --no-trace             Do not record a session trace.
      --no-screenshots       Do not capture screenshots.
      --headful              Run the browser with a visible window.

  Exit codes (so "found problems" is never confused with "could not run"):
    0  ran, every selected check passed and no requirement was left UNVERIFIED
    1  ran and found problems: a check failed, or a requirement was unverified
    3  ran, but a check could not be executed to completion (ERROR, not PASSED;
       takes precedence over 1)
    2  could not run at all: bad pack, no base URL, no browser driver, bad usage

ENVIRONMENT (all optional; nothing here is required to run)
  ALETHEIA_DB, ALETHEIA_RUBRIC, ALETHEIA_RETRIEVAL,
  ALETHEIA_TIMEOUT_MS, ALETHEIA_MAX_SOURCES, ALETHEIA_PER_ADAPTER_LIMIT,
  ALETHEIA_OFFLINE, ALETHEIA_NO_LEDGER, ALETHEIA_USER_AGENT,
  ALETHEIA_WEBSEARCH_BACKENDS, ALETHEIA_REGISTRY_BACKENDS, ALETHEIA_MEDIAWIKI_API,
  DATABASE_URL (switches the ledger to Postgres),
  GITHUB_TOKEN, STACKEXCHANGE_KEY, STACKEXCHANGE_SITE,
  BRAVE_API_KEY, TAVILY_API_KEY, SERPER_API_KEY, GOOGLE_CSE_KEY, GOOGLE_CSE_CX, MOJEEK_API_KEY
  ALETHEIA_BROWSER_DRIVER, ALETHEIA_BROWSER_EXECUTABLE, ALETHEIA_ARTIFACTS_DIR,
  ALETHEIA_PLAYWRIGHT_MODULE

There is no configuration that selects a reasoning model: the engine has no
model path at all. Run with no credentials and the pipeline still completes end
to end on the key-free retrieval paths and the deterministic reasoner. The
browser layer is the same: an already-installed Chromium, no account, no key.
`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleanFlags = new Set(["json", "offline", "no-ledger", "quiet", "help", "strict"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (booleanFlags.has(name)) {
        flags.set(name, [...(flags.get(name) ?? []), "true"]);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(name, [...(flags.get(name) ?? []), "true"]);
        continue;
      }
      flags.set(name, [...(flags.get(name) ?? []), next]);
      i += 1;
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function last(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  return values && values.length > 0 ? values[values.length - 1] : undefined;
}

function all(flags: Map<string, string[]>, name: string): string[] {
  return flags.get(name) ?? [];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const env: Env = process.env as Env;
  const parsed = parseArgs(argv);
  const [command, ...rest] = parsed.positionals;

  if (argv.length === 0 || parsed.flags.has("help") || parsed.flags.has("h")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "adapters") {
    process.stdout.write("Retrieval adapters:\n");
    process.stdout.write(`${describeAdapters(env)}\n\n`);
    process.stdout.write("Reasoning adapters:\n");
    for (const a of allReasoningAdapters()) {
      const available = a.available(env);
      const missing = a.configKeys.filter((k) => !env[k]);
      process.stdout.write(
        `${a.id.padEnd(20)} ${available ? "available" : "unavailable"}  ${a.label}${a.deterministic ? " [deterministic]" : ""}${
          missing.length ? `  [config: ${missing.join(", ")}]` : ""
        }\n`,
      );
    }
    return 0;
  }

  if (command === "browser") {
    const sub = rest[0] ?? "run";
    if (sub === "drivers") {
      process.stdout.write(`Browser drivers (all local, all free; no account, no key):\n\n`);
      process.stdout.write(`${describeBrowserDrivers(env)}\n`);
      return 0;
    }
    if (sub !== "run") {
      process.stderr.write(`unknown browser subcommand "${sub}". Try: browser run --pack <file>, browser drivers\n`);
      return 2;
    }
    const packPath = last(parsed.flags, "pack");
    if (!packPath) {
      process.stderr.write("usage: bun run research browser run --pack <file> [--base-url <url>]\n");
      return 2;
    }
    const dbPath = resolve(last(parsed.flags, "db") ?? env.ALETHEIA_DB ?? DEFAULT_DB_PATH);
    const artifactsDir = last(parsed.flags, "artifacts") ?? env.ALETHEIA_ARTIFACTS_DIR ?? join(dirname(dbPath), "artifacts", "browser");
    const only = last(parsed.flags, "only") ? last(parsed.flags, "only")!.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const quiet = parsed.flags.has("quiet");
    try {
      const result = await verifyWebApp({
        env,
        packPath: resolve(packPath),
        baseUrl: last(parsed.flags, "base-url") ?? null,
        artifactsDir,
        dbPath,
        databaseUrl: env.DATABASE_URL ?? null,
        requirementsPath: last(parsed.flags, "requirements") ?? null,
        driver: last(parsed.flags, "browser") ?? null,
        only,
        recordTrace: !parsed.flags.has("no-trace"),
        screenshots: !parsed.flags.has("no-screenshots"),
        headless: !parsed.flags.has("headful"),
        ledgerEnabled: parsed.flags.has("no-ledger") ? false : undefined,
        runId: last(parsed.flags, "run-id") ?? undefined,
        log: (line) => {
          if (!quiet) process.stderr.write(`  ${line}\n`);
        },
      });
      if (!quiet) {
        for (const note of result.ledgerNotes) process.stderr.write(`note: ${note}\n`);
        if (result.ledgerError) process.stderr.write(`warning: the ledger entry failed: ${result.ledgerError}\n`);
        else if (result.ledgerBackend) process.stderr.write(`ledger: appended verification run ${result.run.run_id} to the ${result.ledgerBackend} ledger\n`);
        process.stderr.write(`artifacts: ${result.run.artifacts.run_dir}\n`);
      }
      if (parsed.flags.has("json")) {
        process.stdout.write(`${JSON.stringify(result.run, null, 2)}\n`);
      } else {
        process.stdout.write(`${result.consoleSummary}\n\n`);
        process.stdout.write(`run id: ${result.run.run_id}\n`);
        process.stdout.write(`outcome digest: ${result.run.outcome_digest}\n`);
        process.stdout.write(`report: ${result.run.artifacts.report_markdown}\n`);
        process.stdout.write(`run record: ${result.run.artifacts.run_json}\n`);
      }
      // A run whose checks failed is a successful verification of a failing app,
      // so the exit code reflects whether the engine could do its job, and a
      // requirement left UNVERIFIED or a check that could not execute is
      // reported explicitly rather than hidden in the exit code.
      if (result.run.coverage.totals.checks.errored > 0) return 3;
      if (result.run.coverage.totals.checks.failed > 0 || result.run.coverage.totals.unverified > 0) return 1;
      return 0;
    } catch (err) {
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  if (command === "rubric") {
    const path = resolve(last(parsed.flags, "rubric") ?? env.ALETHEIA_RUBRIC ?? DEFAULT_RUBRIC_PATH);
    const rubric = loadRubric(path);
    process.stdout.write(`${JSON.stringify({ path, ...rubric }, null, 2)}\n`);
    return 0;
  }

  if (command === "ledger") {
    const sub = rest[0] ?? "list";
    const dbPath = resolve(last(parsed.flags, "db") ?? env.ALETHEIA_DB ?? DEFAULT_DB_PATH);
    const opened = await openLedger({ dbPath, databaseUrl: env.DATABASE_URL ?? null });
    const { ledger } = opened;
    for (const note of opened.notes) process.stderr.write(`note: ${note}\n`);
    try {
      if (sub === "list") {
        const limit = Number(rest[1] ?? 20);
        const rows = await ledger.list(Number.isFinite(limit) ? limit : 20);
        process.stdout.write(
          `ledger (${ledger.backend}) at ${ledger.location} - ${await ledger.count()} entr${(await ledger.count()) === 1 ? "y" : "ies"}\n\n`,
        );
        if (rows.length === 0) process.stdout.write("(empty)\n");
        for (const r of rows) {
          process.stdout.write(
            `${r.seq}\t${r.timestamp}\t${r.confidenceLevel}(${r.confidenceScore})\t${r.runId}\t${r.question.slice(0, 70)}\n`,
          );
        }
        return 0;
      }
      if (sub === "show") {
        const runId = rest[1];
        if (!runId) {
          process.stderr.write("usage: bun run research ledger show <runId>\n");
          return 2;
        }
        const entry = await ledger.get(runId);
        if (!entry) {
          process.stderr.write(`no ledger entry with run id ${runId}\n`);
          return 2;
        }
        process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
        return 0;
      }
      if (sub === "verifications") {
        const limit = Number(rest[1] ?? 20);
        const rows = await ledger.listVerifications(Number.isFinite(limit) ? limit : 20);
        const total = await ledger.countVerifications();
        process.stdout.write(`verification runs in the ${ledger.backend} ledger at ${ledger.location} - ${total} entr${total === 1 ? "y" : "ies"}\n\n`);
        if (rows.length === 0) process.stdout.write("(none)\n");
        for (const r of rows) {
          process.stdout.write(
            `${r.seq}\t${r.timestamp}\t${r.pack_id}@${r.pack_version}\t${r.driver}\tchecks ${r.checks.passed}P/${r.checks.failed}F/${r.checks.errored}E of ${r.checks.total}\tunverified reqs ${r.requirements.unverified}/${r.requirements.total}\t${r.run_id}\n`,
          );
        }
        return 0;
      }
      if (sub === "show-verification") {
        const runId = rest[1];
        if (!runId) {
          process.stderr.write("usage: bun run research ledger show-verification <runId>\n");
          return 2;
        }
        const entry = await ledger.getVerification(runId);
        if (!entry) {
          process.stderr.write(`no verification run with run id ${runId}\n`);
          return 2;
        }
        process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
        return 0;
      }
      if (sub === "verify") {
        const research = await ledger.verifyChain();
        const verification = await ledger.verifyVerificationChain();
        const ok = research.ok && verification.ok;
        process.stdout.write(
          ok
            ? `OK: ${research.checked} research entr${research.checked === 1 ? "y" : "ies"} and ${verification.checked} verification entr${verification.checked === 1 ? "y" : "ies"} verified, both hash chains intact (${ledger.backend} at ${ledger.location})\n`
            : `BROKEN in the ${research.ok ? "verification" : "research"} chain at seq ${research.ok ? verification.brokenAtSeq : research.brokenAtSeq} (run ${research.ok ? verification.brokenAtRunId : research.brokenAtRunId}): ${research.ok ? verification.reason : research.reason}\n`,
        );
        return ok ? 0 : 1;
      }
      process.stderr.write(`unknown ledger subcommand "${sub}"\n`);
      return 2;
    } finally {
      await ledger.close();
    }
  }

  // ---- research ---------------------------------------------------------
  const question = [command, ...rest].filter(Boolean).join(" ").trim();
  if (!question) {
    process.stderr.write("no question given. Try: bun run research \"is X deprecated?\"\n");
    return 2;
  }

  const config = loadConfig(env, {
    dbPath: resolve(last(parsed.flags, "db") ?? env.ALETHEIA_DB ?? DEFAULT_DB_PATH),
    rubricPath: resolve(last(parsed.flags, "rubric") ?? env.ALETHEIA_RUBRIC ?? DEFAULT_RUBRIC_PATH),
    retrievalAdapterIds: last(parsed.flags, "retrieval") ? last(parsed.flags, "retrieval")!.split(",").map((s) => s.trim()) : undefined,
    timeoutMs: last(parsed.flags, "timeout") ? Number(last(parsed.flags, "timeout")) : undefined,
    maxSources: last(parsed.flags, "max-sources") ? Number(last(parsed.flags, "max-sources")) : undefined,
    perAdapterLimit: last(parsed.flags, "per-adapter") ? Number(last(parsed.flags, "per-adapter")) : undefined,
    offline: parsed.flags.has("offline") ? true : undefined,
    ledgerEnabled: parsed.flags.has("no-ledger") ? false : undefined,
  });

  const quiet = parsed.flags.has("quiet");
  const urls = all(parsed.flags, "source");

  if (!quiet) {
    process.stderr.write(`question: ${question}\n`);
    process.stderr.write(`sources supplied: ${urls.length}\n`);
  }

  const result = await runResearch({
    question,
    urls,
    config,
  });

  if (!quiet) {
    for (const note of result.ledgerNotes) process.stderr.write(`note: ${note}\n`);
    for (const o of result.outcomes) {
      process.stderr.write(
        `retrieval ${o.adapter.padEnd(18)} ${o.status.padEnd(12)} ${String(o.docs.length).padStart(3)} source(s)${o.reason ? `  ${o.reason}` : ""}\n`,
      );
    }
    process.stderr.write(
      `evidence: ${result.entry.sources.length} source(s), ${result.entry.claims.length} claim(s), ${result.entry.conflicts.length} conflict(s); confidence ${result.entry.verdict.confidence.level} (${result.entry.verdict.confidence.score})\n`,
    );
    if (result.ledgerError) process.stderr.write(`warning: ledger write failed: ${result.ledgerError}\n`);
    else if (result.ledgerBackend) process.stderr.write(`ledger: appended ${result.entry.runId} to the ${result.ledgerBackend} ledger\n`);
  }

  const outPath = last(parsed.flags, "out");
  if (outPath) {
    const target = resolve(outPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, result.markdown, "utf8");
    if (!quiet) process.stderr.write(`report written to ${target}\n`);
  }

  if (parsed.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.markdown}\n`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // An unexpected exception means the engine could not do its job, so it exits
    // 2 -- the same code as a bad pack or a browser that will not start. Exit 1
    // is reserved for a run that completed and found problems, so a caller can
    // never mistake a crash for a finding.
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(2);
  });
