/**
 * Browser verification, end to end: load a pack, run it, write the artifacts,
 * append ONE entry to the evidence ledger that references those artifacts, and
 * report coverage.
 *
 * Nothing in this path needs an account, a key, or a network service. The
 * browser is already on the machine and both drivers are local.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Env } from "../types.ts";
import { hashHex } from "../util/ids.ts";
import { openLedger } from "../ledger/index.ts";
import { runCheckPack } from "./runner.ts";
import { renderConsoleSummary, renderMarkdownReport } from "./render.ts";
import { SpecError, validatePack, validateRequirementSet } from "./spec.ts";
import { allBrowserDrivers } from "./registry.ts";
import type { CheckPack, RequirementSet, VerificationRun } from "./types.ts";

export interface VerifyOptions {
  env: Env;
  packPath: string;
  baseUrl?: string | null;
  artifactsDir: string;
  dbPath: string;
  databaseUrl: string | null;
  requirementsPath?: string | null;
  driver?: string | null;
  only?: string[] | null;
  recordTrace?: boolean;
  screenshots?: boolean;
  headless?: boolean;
  ledgerEnabled?: boolean;
  runId?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface VerifyResult {
  run: VerificationRun;
  markdown: string;
  consoleSummary: string;
  ledgerNotes: string[];
  ledgerError: string | null;
  ledgerBackend: string | null;
}

export function loadCheckPack(path: string): { pack: CheckPack; sha256: string } {
  if (!existsSync(path)) throw new SpecError([`no check pack at ${path}`]);
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SpecError([`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const pack = validatePack(parsed);
  return { pack, sha256: hashHex(text) };
}

export function loadRequirementSet(path: string): { set: RequirementSet; sha256: string } {
  if (!existsSync(path)) throw new SpecError([`no requirement set at ${path}`]);
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SpecError([`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return { set: validateRequirementSet(parsed), sha256: hashHex(text) };
}

export async function verifyWebApp(opts: VerifyOptions): Promise<VerifyResult> {
  const log = opts.log ?? (() => undefined);
  const packPath = resolve(opts.packPath);
  const { pack, sha256 } = loadCheckPack(packPath);

  let requirementSet: RequirementSet | null = null;
  let requirementSetSha: string | null = null;
  if (opts.requirementsPath) {
    const loaded = loadRequirementSet(resolve(opts.requirementsPath));
    requirementSet = loaded.set;
    requirementSetSha = loaded.sha256;
  }

  const baseUrl = (opts.baseUrl ?? pack.base_url ?? "").trim();
  if (baseUrl === "") {
    throw new SpecError(["no base URL: set base_url in the pack or pass --base-url"]);
  }

  const requirementIds = (() => {
    const map = new Map<string, { id: string; text: string | null; source: "pack" | "file" | "pack+file" | "none" }>();
    for (const r of requirementSet?.requirements ?? []) map.set(r.id, { id: r.id, text: r.text ?? null, source: "file" });
    for (const r of pack.requirements ?? []) {
      const existing = map.get(r.id);
      map.set(r.id, { id: r.id, text: existing?.text ?? r.text ?? null, source: existing ? "pack+file" : "pack" });
    }
    return [...map.values()];
  })();

  const requirementSource: VerificationRun["requirement_set"]["source"] =
    requirementSet && (pack.requirements?.length ?? 0) > 0 ? "pack+file" : requirementSet ? "file" : (pack.requirements?.length ?? 0) > 0 ? "pack" : "none";

  const { run, markdown } = await runCheckPack({
    pack,
    packPath,
    packSha256: sha256,
    baseUrl,
    artifactsDir: resolve(opts.artifactsDir),
    env: opts.env,
    driver: opts.driver ?? null,
    only: opts.only ?? null,
    recordTrace: opts.recordTrace,
    screenshots: opts.screenshots,
    headless: opts.headless,
    runId: opts.runId,
    requirementIds,
    requirementSetMeta: { set_id: requirementSet?.set_id ?? null, version: requirementSet?.version ?? null, sha256: requirementSetSha, source: requirementSource },
    now: opts.now,
    log,
  });

  mkdirSync(run.artifacts.run_dir, { recursive: true });
  writeFileSync(run.artifacts.coverage_json, `${JSON.stringify(run.coverage, null, 2)}\n`, "utf8");
  writeFileSync(run.artifacts.report_markdown, markdown, "utf8");
  writeFileSync(run.artifacts.run_json, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  // One ledger entry per run, referencing the artifacts above.
  const ledgerNotes: string[] = [];
  let ledgerError: string | null = null;
  let ledgerBackend: string | null = null;
  if (opts.ledgerEnabled === false) {
    run.notes.push("the ledger was disabled for this run (--no-ledger), so this run is recorded only in its artifact directory");
    ledgerNotes.push("ledger disabled by request");
  } else {
    try {
      const opened = await openLedger({ dbPath: resolve(opts.dbPath), databaseUrl: opts.databaseUrl });
      ledgerNotes.push(...opened.notes);
      try {
        await opened.ledger.appendVerification(run);
        ledgerBackend = opened.ledger.backend;
        run.notes.push(`appended one entry (${run.hash.slice(0, 16)}…) to the ${opened.ledger.backend} evidence ledger at ${opened.ledger.location}, referencing ${run.artifacts.run_dir}`);
      } finally {
        await opened.ledger.close();
      }
    } catch (err) {
      ledgerError = err instanceof Error ? err.message : String(err);
      run.notes.push(`the ledger entry could not be written: ${ledgerError}`);
    }
  }

  // The run file is rewritten last so that it carries the ledger hash it was
  // recorded under. The artifact and the ledger then agree, byte for byte.
  const finalMarkdown = renderMarkdownReport(run);
  writeFileSync(run.artifacts.run_json, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(run.artifacts.report_markdown, finalMarkdown, "utf8");

  return {
    run,
    markdown: finalMarkdown,
    consoleSummary: renderConsoleSummary(run),
    ledgerNotes,
    ledgerError,
    ledgerBackend,
  };
}

export function describeBrowserDrivers(env: Env): string {
  const lines: string[] = [];
  for (const d of allBrowserDrivers()) {
    const a = d.availability(env);
    lines.push(`${d.id.padEnd(12)} ${a.available ? "available  " : "unavailable"}  ${d.label}`);
    if (!a.available && a.reason) lines.push(`${"".padEnd(12)}   because: ${a.reason}`);
    for (const [k, v] of Object.entries(a.detail)) {
      if (v) lines.push(`${"".padEnd(12)}   ${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

export { runCheckPack, renderMarkdownReport, renderConsoleSummary };
export { validatePack, validateRequirementSet, SpecError } from "./spec.ts";
export type { CheckPack, VerificationRun, RequirementSet };
export const BROWSER_ARTIFACT_DEFAULT = join("artifacts", "browser");
export function defaultArtifactsDir(dbPath: string): string {
  return join(dirname(resolve(dbPath)), BROWSER_ARTIFACT_DEFAULT);
}
