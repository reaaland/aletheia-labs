import type { FailureCode } from "../types.ts";

export interface FetchOutcome {
  ok: boolean;
  status: number | null;
  body: string;
  contentType: string | null;
  lastModified: string | null;
  /** Set when !ok. */
  error: string | null;
  code: FailureCode | null;
  elapsedMs: number;
}

export interface FetchOptions {
  timeoutMs: number;
  userAgent: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  /** 0 = no retry. Only retries idempotent, likely-transient failures. */
  retries?: number;
}

export const DEFAULT_USER_AGENT =
  "AletheiaResearchCore/0.1 (+research; contact: team@localhost) provider-agnostic-evidence-engine";

/**
 * One HTTP entry point for every adapter. Never throws: transport failures are
 * returned as a classified outcome so the pipeline can degrade per-adapter.
 */
export async function httpFetch(url: string, opts: FetchOptions): Promise<FetchOutcome> {
  const retries = opts.retries ?? 0;
  let attempt = 0;
  let last: FetchOutcome | null = null;

  while (attempt <= retries) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          "user-agent": opts.userAgent || DEFAULT_USER_AGENT,
          accept: "text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.5",
          ...(opts.headers ?? {}),
        },
        body: opts.body,
        signal: controller.signal,
        redirect: "follow",
      });
      const body = await res.text();
      const elapsed = Date.now() - started;
      if (!res.ok) {
        const code = classifyStatus(res.status, body);
        last = {
          ok: false,
          status: res.status,
          body,
          contentType: res.headers.get("content-type"),
          lastModified: res.headers.get("last-modified"),
          error: `HTTP ${res.status} ${res.statusText}`.trim(),
          code,
          elapsedMs: elapsed,
        };
        if (code === "rate_limited" && attempt < retries) {
          attempt += 1;
          await sleep(backoffMs(attempt));
          continue;
        }
        return last;
      }
      return {
        ok: true,
        status: res.status,
        body,
        contentType: res.headers.get("content-type"),
        lastModified: res.headers.get("last-modified"),
        error: null,
        code: null,
        elapsedMs: elapsed,
      };
    } catch (err) {
      const elapsed = Date.now() - started;
      const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
      last = {
        ok: false,
        status: null,
        body: "",
        contentType: null,
        lastModified: null,
        error: err instanceof Error ? err.message : String(err),
        code: aborted ? "timeout" : "network_error",
        elapsedMs: elapsed,
      };
      if (attempt < retries) {
        attempt += 1;
        await sleep(backoffMs(attempt));
        continue;
      }
      return last;
    } finally {
      clearTimeout(timer);
    }
  }
  return last as FetchOutcome;
}

export function classifyStatus(status: number, body: string): FailureCode {
  if (status === 429 || /rate.?limit|too many requests|quota/i.test(body.slice(0, 2000))) return "rate_limited";
  if (status === 401 || status === 403) {
    if (/captcha|challenge|automated queries|unusual traffic|blocked/i.test(body.slice(0, 4000))) return "blocked";
    return "auth_error";
  }
  if (status === 404) return "http_error";
  if (status >= 400) return "http_error";
  return "http_error";
}

export function backoffMs(attempt: number): number {
  return Math.min(4000, 250 * 2 ** (attempt - 1));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseJsonLoose<T = unknown>(body: string): { value: T | null; error: string | null } {
  try {
    return { value: JSON.parse(body) as T, error: null };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Best-effort date extraction from a document body when metadata is absent. */
export function guessDate(text: string): { date: string | null; source: "unknown" | "source_metadata" } {
  const iso = /\b((?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/.exec(text);
  if (iso) return { date: new Date(`${iso[1]}T00:00:00.000Z`).toISOString(), source: "source_metadata" };
  const long = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/.exec(
    text,
  );
  if (long) {
    const parsed = new Date(`${long[1]} ${long[2]}, ${long[3]} UTC`);
    if (!Number.isNaN(parsed.getTime())) return { date: parsed.toISOString(), source: "source_metadata" };
  }
  return { date: null, source: "unknown" };
}
