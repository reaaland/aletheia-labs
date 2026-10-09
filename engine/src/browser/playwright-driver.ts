/**
 * Playwright driver.
 *
 * It reuses the Playwright module and the Chromium binary that are ALREADY on
 * this machine: nothing is installed, downloaded, registered or paid for. If
 * either is missing the driver reports itself unavailable with the reason, and
 * the registry falls to the CDP driver instead of failing the run.
 *
 * This is the driver that produces real input events and a real Playwright
 * trace (a .zip that opens in `npx playwright show-trace`), so it is the
 * preferred one when present.
 */
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Env } from "../types.ts";
import {
  findBrowserExecutable,
  findPlaywrightModuleCandidates,
  StepError,
  type BrowserHandle,
  type BrowserSession,
  type DriverAvailability,
  type DriverDescriptor,
  type DriverLaunchOptions,
  type ElementInfo,
  type NavResult,
  type ReadResult,
  type ScreenshotResult,
  type SessionOptions,
  type TraceResult,
} from "./driver.ts";

async function loadPlaywright(env: Env): Promise<any> {
  const problems: string[] = [];
  for (const candidate of findPlaywrightModuleCandidates(env)) {
    try {
      const mod = await import(candidate);
      return mod;
    } catch (err) {
      problems.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`no Playwright module could be loaded (${problems.join(" | ")})`);
}

function timeoutMessage(op: string, selector: string | null, detail: string, elapsedMs: number): string {
  const where = selector ? ` for selector ${JSON.stringify(selector)}` : "";
  return `${op} did not complete${where} within ${elapsedMs}ms: ${detail}`;
}

class PlaywrightSession implements BrowserSession {
  readonly driverId = "playwright";
  private context: any;
  private page: any;
  private events: Record<string, unknown>[] = [];
  private traceStartedAt: number | null = null;
  private constructor(context: any, page: any, private baseUrl: string | null) {
    this.context = context;
    this.page = page;
  }

  static async create(handle: PlaywrightBrowserHandle, opts: SessionOptions, baseUrl: string | null): Promise<PlaywrightSession> {
    const context = await handle.browser.newContext({
      viewport: opts.viewport,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const session = new PlaywrightSession(context, page, baseUrl);
    if (opts.recordTrace) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      session.traceStartedAt = Date.now();
      session.traceEvent({ type: "trace.start", format: "playwright" });
    }
    return session;
  }

  traceEvent(event: Record<string, unknown>): void {
    this.events.push({ at: new Date().toISOString(), driver: "playwright", ...event });
  }

  private async withStep<T>(op: string, selector: string | null, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } catch (err) {
      const elapsed = Date.now() - started;
      const message = timeoutMessage(op, selector, err instanceof Error ? err.message.split("\n")[0] : String(err), Math.max(elapsed, timeoutMs));
      throw new StepError(op, selector, message, elapsed);
    }
  }

  private locator(selector: string): any {
    return this.page.locator(selector).first();
  }

  async goto(url: string, waitUntil: "load" | "domcontentloaded"): Promise<NavResult> {
    return this.withStep("navigate", url, 15_000, async () => {
      const response = await this.page.goto(url, { waitUntil, timeout: 15_000 });
      this.traceEvent({ type: "navigate", url, status: response ? response.status() : null });
      return { url: this.page.url(), status: response ? response.status() : null, title: await this.page.title() };
    });
  }

  async click(selector: string, timeoutMs: number): Promise<ElementInfo> {
    return this.withStep("click", selector, timeoutMs, async () => {
      const loc = this.locator(selector);
      const count = await loc.count();
      if (count === 0) throw new Error("no element matched");
      await loc.click({ timeout: timeoutMs });
      this.traceEvent({ type: "click", selector });
      return this.describe(selector, timeoutMs);
    });
  }

  async type(selector: string, text: string, opts: { clear: boolean; pressEnter: boolean; timeoutMs: number }): Promise<ElementInfo> {
    return this.withStep("type", selector, opts.timeoutMs, async () => {
      const loc = this.locator(selector);
      const count = await loc.count();
      if (count === 0) throw new Error("no element matched");
      if (opts.clear) await loc.fill("", { timeout: opts.timeoutMs });
      await loc.pressSequentially(text, { timeout: opts.timeoutMs });
      if (opts.pressEnter) await loc.press("Enter", { timeout: opts.timeoutMs });
      this.traceEvent({ type: "type", selector, text, clear: opts.clear, press_enter: opts.pressEnter });
      return this.describe(selector, opts.timeoutMs);
    });
  }

  private async describe(selector: string, timeoutMs: number): Promise<ElementInfo> {
    const loc = this.page.locator(selector);
    const count = await loc.count();
    const first = loc.first();
    const visible = count > 0 ? await first.isVisible().catch(() => false) : false;
    const text = count > 0 ? ((await first.innerText().catch(() => "")) ?? "") : "";
    const value = count > 0 ? await first.inputValue().catch(() => null) : null;
    const attributes: Record<string, string> = {};
    if (count > 0) {
      const attrs = await first.evaluate((el: Element) => {
        const out: Record<string, string> = {};
        for (const a of Array.from(el.attributes)) out[a.name] = a.value;
        return out;
      });
      Object.assign(attributes, attrs);
    }
    this.traceEvent({ type: "describe", selector, count, visible });
    return { selector, resolved: selector, count, visible, text, value, attributes };
  }

  async read(selector: string | null, from: "text" | "value" | "attribute" | "count" | "url", attribute: string | null, timeoutMs: number): Promise<ReadResult> {
    if (from === "url") {
      return { ok: true, count: 1, visible: true, text: this.page.url(), value: this.page.url(), attributes: {}, url: this.page.url() };
    }
    const sel = selector ?? "body";
    return this.withStep("read", sel, timeoutMs, async () => {
      const loc = this.page.locator(sel);
      const count = await loc.count();
      const first = loc.first();
      const visible = count > 0 ? await first.isVisible().catch(() => false) : false;
      let text = "";
      let value: string | null = null;
      const attributes: Record<string, string> = {};
      if (count > 0) {
        if (from === "text") text = (await first.innerText().catch(async () => (await first.textContent()) ?? "")) ?? "";
        if (from === "value") value = await first.inputValue().catch(() => null);
        if (from === "attribute") {
          if (!attribute) throw new Error("read with from=attribute needs an attribute name");
          value = await first.getAttribute(attribute).catch(() => null);
        }
        const attrs = await first.evaluate((el: Element) => {
          const out: Record<string, string> = {};
          for (const a of Array.from(el.attributes)) out[a.name] = a.value;
          return out;
        });
        Object.assign(attributes, attrs);
      }
      this.traceEvent({ type: "read", selector: sel, from, count });
      return { ok: true, count, visible, text, value, attributes, url: this.page.url() };
    });
  }

  async readAll(selector: string, item: { sub_selector?: string; attribute?: string } | null, timeoutMs: number): Promise<string[]> {
    return this.withStep("read_many", selector, timeoutMs, async () => {
      const root = this.page.locator(selector);
      const count = await root.count();
      const out: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const el = item?.sub_selector ? root.nth(i).locator(item.sub_selector).first() : root.nth(i);
        if (item?.attribute) {
          const v = await el.getAttribute(item.attribute).catch(() => null);
          out.push(v ?? "");
        } else {
          out.push(((await el.innerText().catch(async () => (await el.textContent()) ?? "")) ?? "").trim());
        }
      }
      this.traceEvent({ type: "read_many", selector, count });
      return out;
    });
  }

  async waitFor(selector: string, state: "visible" | "hidden" | "attached" | "detached", timeoutMs: number): Promise<void> {
    await this.withStep("wait_for", selector, timeoutMs, async () => {
      await this.page.locator(selector).first().waitFor({ state, timeout: timeoutMs });
      this.traceEvent({ type: "wait_for", selector, state });
    });
  }

  async waitForText(selector: string | null, text: string, mode: "contains" | "equals", timeoutMs: number): Promise<string> {
    const sel = selector ?? "body";
    return this.withStep("wait_for_text", sel, timeoutMs, async () => {
      const deadline = Date.now() + timeoutMs;
      let seen = "";
      for (;;) {
        seen = await this.visibleText(sel, timeoutMs);
        const matched = mode === "equals" ? seen.trim() === text : seen.includes(text);
        if (matched) return seen;
        if (Date.now() >= deadline) throw new Error(`text ${JSON.stringify(text)} never appeared; last seen: ${JSON.stringify(seen.slice(0, 200))}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    });
  }

  async visibleText(selector: string | null, timeoutMs: number): Promise<string> {
    const sel = selector ?? "body";
    return this.withStep("visible_text", sel, timeoutMs, async () => {
      const loc = this.page.locator(sel).first();
      return ((await loc.innerText().catch(async () => (await loc.textContent()) ?? "")) ?? "").replace(/\s+/g, " ").trim();
    });
  }

  async screenshot(path: string, fullPage: boolean): Promise<ScreenshotResult> {
    mkdirSync(dirname(path), { recursive: true });
    return this.withStep("screenshot", null, 10_000, async () => {
      await this.page.screenshot({ path, fullPage });
      this.traceEvent({ type: "screenshot", path, full_page: fullPage });
      const bytes = statSync(path).size;
      const size = this.page.viewportSize();
      return { path, bytes, width: size?.width ?? null, height: size?.height ?? null };
    });
  }

  async stopTrace(path: string): Promise<TraceResult> {
    mkdirSync(dirname(path), { recursive: true });
    if (this.traceStartedAt === null) return { path, format: "playwright-zip", events: 0, bytes: 0 };
    await this.context.tracing.stop({ path });
    this.traceEvent({ type: "trace.stop", path });
    return { path, format: "playwright-zip", events: this.events.length, bytes: statSync(path).size };
  }

  currentUrl(): string {
    return this.page.url();
  }

  async close(): Promise<void> {
    try {
      await this.context.close();
    } catch {
      /* the browser may already be gone; nothing to salvage here */
    }
  }
}

class PlaywrightBrowserHandle implements BrowserHandle {
  readonly id = "playwright";
  readonly label: string;
  readonly executable: string | null;
  readonly executableSource: string;
  readonly browser: any;
  private constructor(browser: any, executable: string | null, executableSource: string, label: string) {
    this.browser = browser;
    this.executable = executable;
    this.executableSource = executableSource;
    this.label = label;
  }

  static async launch(opts: DriverLaunchOptions): Promise<PlaywrightBrowserHandle> {
    const pw = await loadPlaywright(opts.env);
    const found = findBrowserExecutable(opts.env);
    if (found.path === null) throw new Error(`no browser binary: ${found.source}`);
    const browser = await pw.chromium.launch({
      executablePath: found.path,
      headless: opts.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const version = typeof browser.version === "function" ? await browser.version().catch(() => null) : null;
    return new PlaywrightBrowserHandle(browser, found.path, found.source, `playwright + ${version ?? "chromium"}`);
  }

  async openSession(opts: SessionOptions): Promise<BrowserSession> {
    return PlaywrightSession.create(this, opts, null);
  }

  async close(): Promise<void> {
    try {
      await this.browser.close();
    } catch {
      /* already closed */
    }
  }
}

export const playwrightDriver: DriverDescriptor = {
  id: "playwright",
  label: "Playwright over an already-installed Chromium (real input events, real trace)",
  configKeys: [],
  availability(env: Env): DriverAvailability {
    const found = findBrowserExecutable(env);
    const detail: Record<string, string | null> = {
      browser_executable: found.path,
      browser_source: found.source,
      module_candidates: findPlaywrightModuleCandidates(env).join(", "),
    };
    if (found.path === null) return { available: false, reason: found.source, detail };
    return { available: true, reason: null, detail };
  },
  async launch(opts: DriverLaunchOptions): Promise<BrowserHandle> {
    return PlaywrightBrowserHandle.launch(opts);
  },
};
