/**
 * The browser driver layer.
 *
 * A driver is the thing that can actually make a browser do something. Nothing
 * above this file knows which one is in use, and no driver is load-bearing: the
 * registry below offers two independent implementations, chosen by
 * configuration, and the selection records WHY it chose what it chose so the
 * receipt can state it.
 *
 *   playwright  - reuses a Playwright module that is already on the machine and
 *                 an already-installed Chromium/Chrome binary. Real input
 *                 events, a real Playwright trace.
 *   cdp         - drives an already-installed Chromium over the DevTools
 *                 Protocol with no third-party dependency at all, using the
 *                 runtime's own WebSocket. Fallback if Playwright is absent.
 *
 * Both are local, free, and need no account, key or network service.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../types.ts";

export interface ElementInfo {
  /** The CSS selector actually used. */
  selector: string;
  /** The resolved selector that matched, when the driver can report it. */
  resolved: string;
  count: number;
  visible: boolean;
  text: string;
  value: string | null;
  attributes: Record<string, string>;
}

export interface ReadResult {
  ok: true;
  count: number;
  visible: boolean;
  text: string;
  value: string | null;
  attributes: Record<string, string>;
  url: string;
}

export interface NavResult {
  url: string;
  status: number | null;
  title: string;
}

export interface ScreenshotResult {
  path: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface TraceResult {
  path: string;
  format: "playwright-zip" | "cdp-session-log";
  events: number;
  bytes: number;
}

/** A step-level failure: the action could not be executed. */
export class StepError extends Error {
  readonly op: string;
  readonly selector: string | null;
  readonly elapsedMs: number;
  constructor(op: string, selector: string | null, message: string, elapsedMs = 0) {
    super(message);
    this.name = "StepError";
    this.op = op;
    this.selector = selector;
    this.elapsedMs = elapsedMs;
  }
}

export interface SessionOptions {
  /** Where screenshots and traces for this session are written. */
  artifactDir: string;
  /** Default timeout for every wait, in milliseconds. */
  timeoutMs: number;
  viewport: { width: number; height: number };
  recordTrace: boolean;
}

export interface BrowserSession {
  readonly driverId: string;
  /** Base URL for relative `navigate` paths. */
  goto(url: string, waitUntil: "load" | "domcontentloaded"): Promise<NavResult>;
  click(selector: string, timeoutMs: number): Promise<ElementInfo>;
  type(selector: string, text: string, opts: { clear: boolean; pressEnter: boolean; timeoutMs: number }): Promise<ElementInfo>;
  read(selector: string | null, from: "text" | "value" | "attribute" | "count" | "url", attribute: string | null, timeoutMs: number): Promise<ReadResult>;
  /** Texts of every element matching `selector`, in document order. */
  readAll(selector: string, item: { sub_selector?: string; attribute?: string } | null, timeoutMs: number): Promise<string[]>;
  waitFor(selector: string, state: "visible" | "hidden" | "attached" | "detached", timeoutMs: number): Promise<void>;
  waitForText(selector: string | null, text: string, mode: "contains" | "equals", timeoutMs: number): Promise<string>;
  /** Visible text of `selector` (or of the whole body when null). */
  visibleText(selector: string | null, timeoutMs: number): Promise<string>;
  screenshot(path: string, fullPage: boolean): Promise<ScreenshotResult>;
  /** Record one driver-level action in the session trace. */
  traceEvent(event: Record<string, unknown>): void;
  stopTrace(path: string): Promise<TraceResult>;
  currentUrl(): string;
  close(): Promise<void>;
}

export interface BrowserHandle {
  readonly id: string;
  readonly label: string;
  readonly executable: string | null;
  /** How the browser binary was found, for the receipt. */
  readonly executableSource: string;
  openSession(opts: SessionOptions): Promise<BrowserSession>;
  close(): Promise<void>;
}

export interface DriverAvailability {
  available: boolean;
  reason: string | null;
  /** Non-null when the driver needs an external thing (browser binary, module). */
  detail: Record<string, string | null>;
}

export interface DriverLaunchOptions {
  env: Env;
  headless: boolean;
  fingerprint?: { width: number; height: number };
}

export interface DriverDescriptor {
  id: string;
  label: string;
  /** Config keys that make this driver usable; empty means it needs nothing. */
  configKeys: string[];
  availability(env: Env): DriverAvailability;
  launch(opts: DriverLaunchOptions): Promise<BrowserHandle>;
}

// ---------------------------------------------------------------------------
// Browser binary discovery -- reuse what is already installed, download nothing
// ---------------------------------------------------------------------------

const CHROMIUM_CANDIDATES = [
  "/usr/local/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
];

/**
 * Find a Chromium-family binary already on this machine.
 *
 * Order: an explicit setting, then PATH-ish fixed locations, then the browser
 * directories Playwright-style installs use. Nothing is ever downloaded.
 */
export function findBrowserExecutable(env: Env): { path: string | null; source: string } {
  const explicit = [env.ALETHEIA_BROWSER_EXECUTABLE, env.CHROME_PATH, env.CHROMIUM_PATH];
  for (const candidate of explicit) {
    if (candidate && candidate.trim() !== "") {
      const p = candidate.trim();
      return existsSync(p) ? { path: p, source: "configured by environment" } : { path: null, source: `configured path does not exist: ${p}` };
    }
  }
  for (const p of CHROMIUM_CANDIDATES) {
    if (existsSync(p)) return { path: p, source: "already installed on this machine" };
  }
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, "/opt/browsers", join(env.HOME ?? "", ".cache", "ms-playwright")].filter(
    (r): r is string => typeof r === "string" && r !== "",
  );
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const dirs = entries.filter((e) => e.startsWith("chromium-") || e.startsWith("chromium_headless_shell-")).sort();
    for (const d of dirs) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
        const p = join(root, d, rel);
        if (existsSync(p)) return { path: p, source: `already installed on this machine (${root})` };
      }
    }
  }
  return { path: null, source: "no Chromium-family binary found on this machine" };
}

/** Playwright is not installed by us; we resolve an already-present module or fail loudly. */
export function findPlaywrightModuleCandidates(env: Env): string[] {
  const out: string[] = [];
  if (env.ALETHEIA_PLAYWRIGHT_MODULE) out.push(env.ALETHEIA_PLAYWRIGHT_MODULE);
  out.push("playwright", "/usr/lib/node_modules/playwright/index.mjs", "/usr/local/lib/node_modules/playwright/index.mjs");
  return out;
}

export function playwrightModuleCandidatesForReport(env: Env): string[] {
  return findPlaywrightModuleCandidates(env);
}
