/**
 * CDP driver: drives an already-installed Chromium over the DevTools Protocol
 * using the runtime's own WebSocket. No third-party package, no download, no
 * account. This is the fallback that keeps the layer working when no Playwright
 * module can be loaded, and it is a genuinely independent implementation of the
 * same interface (a different mechanism, not a wrapper).
 *
 * Honest limitation, recorded in every trace it writes: clicks and typing are
 * performed by scripted DOM calls (`element.click()`, setting `value` and
 * dispatching `input`/`change` events), not by synthesized OS-level pointer and
 * keyboard input the way Playwright does it. That is enough to drive a normal
 * form, but a page that only reacts to trusted events would behave differently
 * here. The trace says which mechanism was used for every action, so a finding
 * never overstates what was done.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "../types.ts";
import {
  findBrowserExecutable,
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

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(msg: any) => void>();
  private closed = false;

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent) => {
      let parsed: any;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (parsed.id !== undefined && this.pending.has(parsed.id)) {
        const p = this.pending.get(parsed.id)!;
        this.pending.delete(parsed.id);
        clearTimeout(p.timer);
        if (parsed.error) p.reject(new Error(`${parsed.error.message ?? "CDP error"}${parsed.error.data ? ` (${parsed.error.data})` : ""}`));
        else p.resolve(parsed.result);
        return;
      }
      for (const l of this.listeners) l(parsed);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("the browser connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string, timeoutMs = 15_000): Promise<CdpConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${url}`));
      });
    });
    return new CdpConnection(ws);
  }

  onMessage(cb: (msg: any) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("the browser connection is closed"));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* nothing to do */
    }
  }
}

/** Wait for DevToolsActivePort, which Chrome writes once the debug port is bound. */
async function waitForDebugPort(userDataDir: string, timeoutMs: number): Promise<{ port: number; path: string }> {
  const file = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = readFileSync(file, "utf8").trim().split("\n");
      const port = Number(text[0]);
      if (Number.isFinite(port) && port > 0) return { port, path: text[1] ?? "/devtools/browser" };
    } catch {
      /* not written yet */
    }
    if (Date.now() >= deadline) throw new Error(`the browser never reported a DevTools port within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const queryHelpers = `
  const __one = (sel) => document.querySelector(sel);
  const __all = (sel) => Array.from(document.querySelectorAll(sel));
  const __visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
`;

function jsString(value: string): string {
  return JSON.stringify(value);
}

class CdpSession implements BrowserSession {
  readonly driverId = "cdp";
  private events: Record<string, unknown>[] = [];
  private url = "about:blank";
  private detached: () => void = () => {};
  private constructor(private conn: CdpConnection, private sessionId: string, private targetId: string, private viewport: { width: number; height: number }, private recordTrace: boolean) {}

  static async create(conn: CdpConnection, viewport: { width: number; height: number }, recordTrace: boolean): Promise<CdpSession> {
    const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const session = new CdpSession(conn, sessionId, targetId, viewport, recordTrace);
    await conn.send("Page.enable", {}, sessionId);
    await conn.send("Runtime.enable", {}, sessionId);
    await conn.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId).catch(() => undefined);
    session.detached = conn.onMessage((msg) => {
      if (msg.method === "Page.frameNavigated" && msg.sessionId === sessionId && msg.params?.frame?.parentId === undefined) {
        session.url = msg.params.frame.url;
      }
    });
    if (recordTrace) session.traceEvent({ type: "trace.start", format: "cdp-session-log" });
    return session;
  }

  traceEvent(event: Record<string, unknown>): void {
    if (!this.recordTrace) return;
    this.events.push({ at: new Date().toISOString(), driver: "cdp", ...event });
  }

  private async evaluate<T>(expression: string, timeoutMs: number): Promise<T> {
    const res = await this.conn.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      this.sessionId,
      timeoutMs,
    );
    if (res?.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "script error in the page";
      throw new Error(String(detail).split("\n")[0]);
    }
    return res?.result?.value as T;
  }

  private async withStep<T>(op: string, selector: string | null, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } catch (err) {
      const elapsed = Date.now() - started;
      const where = selector ? ` for selector ${JSON.stringify(selector)}` : "";
      const message = `${op} did not complete${where} within ${timeoutMs}ms: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
      throw new StepError(op, selector, message, elapsed);
    }
  }

  async goto(url: string, waitUntil: "load" | "domcontentloaded"): Promise<NavResult> {
    return this.withStep("navigate", url, 15_000, async () => {
      const nav = await this.conn.send("Page.navigate", { url }, this.sessionId, 20_000);
      if (nav?.errorText) throw new Error(nav.errorText);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const ready = await this.evaluate<string>("document.readyState", 5_000).catch(() => "loading");
        if (ready === "complete" || (waitUntil === "domcontentloaded" && (ready === "interactive" || ready === "complete"))) break;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      this.url = await this.evaluate<string>("location.href", 5_000);
      const title = await this.evaluate<string>("document.title", 5_000);
      this.traceEvent({ type: "navigate", url: this.url, status: null, mechanism: "Page.navigate" });
      return { url: this.url, status: null, title };
    });
  }

  private async describe(selector: string, timeoutMs: number): Promise<ElementInfo> {
    const info = await this.evaluate<{ count: number; visible: boolean; text: string; value: string | null; attributes: Record<string, string> }>(
      `(() => {${queryHelpers}
        const els = __all(${jsString(selector)});
        const el = els[0];
        return { count: els.length, visible: __visible(el), text: el ? (el.innerText ?? el.textContent ?? "") : "", value: el && "value" in el ? String(el.value) : null, attributes: el ? Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])) : {} };
      })()`,
      timeoutMs,
    );
    return { selector, resolved: selector, count: info.count, visible: info.visible, text: info.text, value: info.value, attributes: info.attributes };
  }

  async click(selector: string, timeoutMs: number): Promise<ElementInfo> {
    return this.withStep("click", selector, timeoutMs, async () => {
      const res = await this.evaluate<{ ok: boolean; reason?: string }>(
        `(() => {${queryHelpers}
          const el = __one(${jsString(selector)});
          if (!el) return { ok: false, reason: "no element matched" };
          el.scrollIntoView({ block: "center" });
          el.click();
          return { ok: true };
        })()`,
        timeoutMs,
      );
      if (!res.ok) throw new Error(res.reason ?? "click failed");
      this.traceEvent({ type: "click", selector, mechanism: "dom_element_click" });
      return this.describe(selector, timeoutMs);
    });
  }

  async type(selector: string, text: string, opts: { clear: boolean; pressEnter: boolean; timeoutMs: number }): Promise<ElementInfo> {
    return this.withStep("type", selector, opts.timeoutMs, async () => {
      const res = await this.evaluate<{ ok: boolean; reason?: string }>(
        `(() => {${queryHelpers}
          const el = __one(${jsString(selector)});
          if (!el) return { ok: false, reason: "no element matched" };
          el.focus();
          const next = ${opts.clear ? "''" : "String(el.value ?? '')"} + ${jsString(text)};
          el.value = next;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          ${opts.pressEnter ? 'el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); if (el.form && typeof el.form.requestSubmit === "function") el.form.requestSubmit();' : ""}
          return { ok: true };
        })()`,
        opts.timeoutMs,
      );
      if (!res.ok) throw new Error(res.reason ?? "typing failed");
      this.traceEvent({ type: "type", selector, text, clear: opts.clear, press_enter: opts.pressEnter, mechanism: "dom_value_set" });
      return this.describe(selector, opts.timeoutMs);
    });
  }

  async read(selector: string | null, from: "text" | "value" | "attribute" | "count" | "url", attribute: string | null, timeoutMs: number): Promise<ReadResult> {
    if (from === "url") {
      const url = await this.evaluate<string>("location.href", timeoutMs);
      this.url = url;
      return { ok: true, count: 1, visible: true, text: url, value: url, attributes: {}, url };
    }
    if (from === "attribute" && !attribute) throw new StepError("read", selector, "read with from=attribute needs an attribute name");
    const info = await this.withStep("read", selector, timeoutMs, () => this.describe(selector ?? "body", timeoutMs));
    const value = from === "value" ? info.value : from === "attribute" ? (info.attributes[attribute as string] ?? null) : info.text;
    this.traceEvent({ type: "read", selector, from, count: info.count, mechanism: "Runtime.evaluate" });
    return { ok: true, count: info.count, visible: info.visible, text: info.text, value, attributes: info.attributes, url: this.url };
  }

  async readAll(selector: string, item: { sub_selector?: string; attribute?: string } | null, timeoutMs: number): Promise<string[]> {
    return this.withStep("read_many", selector, timeoutMs, async () => {
      const out = await this.evaluate<string[]>(
        `(() => {${queryHelpers}
          return __all(${jsString(selector)}).map(el => {
            const target = ${item?.sub_selector ? `el.querySelector(${jsString(item.sub_selector)})` : "el"};
            if (!target) return "";
            ${item?.attribute ? `return target.getAttribute(${jsString(item.attribute)}) ?? "";` : "return String(target.innerText ?? target.textContent ?? '').trim();"}
          });
        })()`,
        timeoutMs,
      );
      this.traceEvent({ type: "read_many", selector, count: out.length, mechanism: "Runtime.evaluate" });
      return out;
    });
  }

  async waitFor(selector: string, state: "visible" | "hidden" | "attached" | "detached", timeoutMs: number): Promise<void> {
    await this.withStep("wait_for", selector, timeoutMs, async () => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const info = await this.evaluate<{ count: number; visible: boolean }>(
          `(() => {${queryHelpers} const els = __all(${jsString(selector)}); return { count: els.length, visible: __visible(els[0]) }; })()`,
          timeoutMs,
        );
        const ok =
          state === "visible" ? info.count > 0 && info.visible :
          state === "attached" ? info.count > 0 :
          state === "hidden" ? !(info.count > 0 && info.visible) :
          info.count === 0;
        if (ok) return;
        if (Date.now() >= deadline) throw new Error(`element never became ${state} (count=${info.count})`);
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    this.traceEvent({ type: "wait_for", selector, state });
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
      const text = await this.evaluate<string>(
        `(() => {${queryHelpers} const el = __one(${jsString(sel)}); return el ? String(el.innerText ?? el.textContent ?? "") : ""; })()`,
        timeoutMs,
      );
      return (text ?? "").replace(/\s+/g, " ").trim();
    });
  }

  async screenshot(path: string, fullPage: boolean): Promise<ScreenshotResult> {
    mkdirSync(dirname(path), { recursive: true });
    return this.withStep("screenshot", null, 20_000, async () => {
      const res = await this.conn.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage }, this.sessionId, 20_000);
      const bytes = Buffer.from(res.data as string, "base64");
      await Bun.write(path, bytes);
      this.traceEvent({ type: "screenshot", path, full_page: fullPage, mechanism: "Page.captureScreenshot" });
      return { path, bytes: statSync(path).size, width: this.viewport.width, height: this.viewport.height };
    });
  }

  async stopTrace(path: string): Promise<TraceResult> {
    mkdirSync(dirname(path), { recursive: true });
    const lines = this.events.map((e) => JSON.stringify(e));
    await Bun.write(path, lines.length ? `${lines.join("\n")}\n` : "");
    return { path, format: "cdp-session-log", events: lines.length, bytes: statSync(path).size };
  }

  currentUrl(): string {
    return this.url;
  }

  async close(): Promise<void> {
    this.detached();
    try {
      await this.conn.send("Target.closeTarget", { targetId: this.targetId }, undefined, 5_000);
    } catch {
      /* the target may already be gone */
    }
  }
}

class CdpBrowserHandle implements BrowserHandle {
  readonly id = "cdp";
  readonly label: string;
  readonly executable: string | null;
  readonly executableSource: string;
  private userDataDir: string;
  private constructor(private proc: any, private conn: CdpConnection, executable: string, source: string, userDataDir: string, label: string) {
    this.executable = executable;
    this.executableSource = source;
    this.userDataDir = userDataDir;
    this.label = label;
  }

  static async launch(opts: DriverLaunchOptions): Promise<CdpBrowserHandle> {
    const found = findBrowserExecutable(opts.env);
    if (found.path === null) throw new Error(`no browser binary: ${found.source}`);
    const userDataDir = mkdtempSync(join(tmpdir(), "aletheia-cdp-"));
    const args = [
      found.path,
      opts.headless ? "--headless=new" : "--headless",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ];
    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    const { port, path } = await waitForDebugPort(userDataDir, 20_000);
    const conn = await CdpConnection.connect(`ws://127.0.0.1:${port}${path}`);
    const version = await conn.send("Browser.getVersion").catch(() => null);
    return new CdpBrowserHandle(proc, conn, found.path, found.source, userDataDir, `cdp + ${version?.product ?? "chromium"}`);
  }

  async openSession(opts: SessionOptions): Promise<BrowserSession> {
    return CdpSession.create(this.conn, opts.viewport, opts.recordTrace);
  }

  async close(): Promise<void> {
    try {
      await this.conn.send("Browser.close", {}, undefined, 3_000);
    } catch {
      /* ignore */
    }
    this.conn.close();
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    try {
      rmSync(this.userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export const cdpDriver: DriverDescriptor = {
  id: "cdp",
  label: "raw DevTools Protocol over the runtime's own WebSocket (no third-party dependency)",
  configKeys: [],
  availability(env: Env): DriverAvailability {
    const found = findBrowserExecutable(env);
    if (found.path === null) return { available: false, reason: found.source, detail: { browser_executable: null, browser_source: found.source } };
    return { available: true, reason: null, detail: { browser_executable: found.path, browser_source: found.source } };
  },
  async launch(opts: DriverLaunchOptions): Promise<BrowserHandle> {
    return CdpBrowserHandle.launch(opts);
  },
};
