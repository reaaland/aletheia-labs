import type { AdapterOutcome, Env, FailureCode, RetrievalAdapter, RetrievalRequest, SourceDoc } from "../types.ts";
import { fetchDoc, mapLimit, okOutcome, unavailableOutcome } from "./common.ts";
import { httpFetch, parseJsonLoose } from "../util/http.ts";
import { domainOf, queryVariants } from "../util/text.ts";
import { genericTermsOf } from "./common.ts";

/**
 * Retrieval path (b): a general web-search API adapter.
 *
 * One interface, several interchangeable backends. Backends that need a
 * credential are inert until that credential exists in the environment; the
 * key-free backends are the default. If every backend is blocked, rate-limited
 * or empty, the adapter reports "unavailable" with the reason and the pipeline
 * carries on with whatever else answered.
 *
 * Backends are selected with ALETHEIA_WEBSEARCH_BACKENDS (comma separated).
 */
export interface SearchHit {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string | null;
}

export interface SearchBackend {
  id: string;
  label: string;
  /** Env vars that make this backend usable. Empty = key-free. */
  configKeys: string[];
  keyFree: boolean;
  search(query: string, limit: number, req: RetrievalRequest): Promise<{ hits: SearchHit[]; error: string | null; code: FailureCode | null }>;
}

const KEY_FREE_BACKENDS = ["hn-algolia", "marginalia"];

/** Hacker News search (Algolia). Free, no key, JSON, indexes arbitrary web URLs. */
export const hnAlgoliaBackend: SearchBackend = {
  id: "hn-algolia",
  label: "Hacker News search API (Algolia)",
  configKeys: [],
  keyFree: true,
  async search(query, limit, req) {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(
      50,
      Math.max(limit * 3, 10),
    )}&tags=story`;
    const res = await httpFetch(url, { timeoutMs: req.timeoutMs, userAgent: req.userAgent, retries: 1 });
    if (!res.ok) return { hits: [], error: res.error, code: res.code };
    const parsed = parseJsonLoose<{ hits?: any[] }>(res.body);
    if (!parsed.value) return { hits: [], error: `unparseable JSON: ${parsed.error}`, code: "parse_error" };
    const hits: SearchHit[] = [];
    for (const h of parsed.value.hits ?? []) {
      const target = typeof h.url === "string" && h.url.startsWith("http") ? h.url : null;
      const story = `https://news.ycombinator.com/item?id=${h.objectID}`;
      const item = h.story_text ? story : null;
      const urlToUse = target ?? item;
      if (!urlToUse) continue;
      hits.push({
        url: urlToUse,
        title: String(h.title ?? urlToUse),
        snippet: typeof h.story_text === "string" ? h.story_text : undefined,
        publishedAt: typeof h.created_at === "string" ? h.created_at : null,
      });
    }
    return { hits, error: null, code: null };
  },
};

/** Marginalia search: independent crawler index, key-free HTML. Low yield but genuinely independent. */
export const marginaliaBackend: SearchBackend = {
  id: "marginalia",
  label: "Marginalia search (independent index)",
  configKeys: [],
  keyFree: true,
  async search(query, limit, req) {
    const url = `https://marginalia-search.com/search?query=${encodeURIComponent(query)}`;
    const res = await httpFetch(url, { timeoutMs: req.timeoutMs, userAgent: req.userAgent });
    if (!res.ok) return { hits: [], error: res.error, code: res.code };
    const hits = extractExternalLinks(res.body, ["marginalia-search.com", "marginalia.nu"], limit);
    if (hits.length === 0) {
      return { hits: [], error: "index returned no external results for this query", code: "empty_result" };
    }
    return { hits, error: null, code: null };
  },
};

/** Brave Search API. Inert unless BRAVE_API_KEY is set. */
export const braveBackend: SearchBackend = {
  id: "brave",
  label: "Brave Search API",
  configKeys: ["BRAVE_API_KEY"],
  keyFree: false,
  async search(query, limit, req) {
    const key = req.env.BRAVE_API_KEY as string;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, limit)}`;
    const res = await httpFetch(url, {
      timeoutMs: req.timeoutMs,
      userAgent: req.userAgent,
      headers: { "x-subscription-token": key, accept: "application/json" },
    });
    if (!res.ok) return { hits: [], error: res.error, code: res.code };
    const parsed = parseJsonLoose<any>(res.body);
    if (!parsed.value) return { hits: [], error: "unparseable JSON", code: "parse_error" };
    const results = parsed.value?.web?.results ?? [];
    return {
      hits: results.map((r: any) => ({ url: r.url, title: r.title ?? r.url, snippet: r.description, publishedAt: r.age ?? null })),
      error: null,
      code: null,
    };
  },
};

/** Tavily search API. Inert unless TAVILY_API_KEY is set. */
export const tavilyBackend: SearchBackend = {
  id: "tavily",
  label: "Tavily search API",
  configKeys: ["TAVILY_API_KEY"],
  keyFree: false,
  async search(query, limit, req) {
    const res = await httpFetch("https://api.tavily.com/search", {
      timeoutMs: req.timeoutMs,
      userAgent: req.userAgent,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: req.env.TAVILY_API_KEY, query, max_results: limit, search_depth: "basic" }),
    });
    if (!res.ok) return { hits: [], error: res.error, code: res.code };
    const parsed = parseJsonLoose<any>(res.body);
    if (!parsed.value) return { hits: [], error: "unparseable JSON", code: "parse_error" };
    const results = parsed.value?.results ?? [];
    return { hits: results.map((r: any) => ({ url: r.url, title: r.title ?? r.url, snippet: r.content })), error: null, code: null };
  },
};

/** Serper (Google SERP) API. Inert unless SERPER_API_KEY is set. */
export const serperBackend: SearchBackend = {
  id: "serper",
  label: "Serper search API",
  configKeys: ["SERPER_API_KEY"],
  keyFree: false,
  async search(query, limit, req) {
    const res = await httpFetch("https://google.serper.dev/search", {
      timeoutMs: req.timeoutMs,
      userAgent: req.userAgent,
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": String(req.env.SERPER_API_KEY) },
      body: JSON.stringify({ q: query, num: limit }),
    });
    if (!res.ok) return { hits: [], error: res.error, code: res.code };
    const parsed = parseJsonLoose<any>(res.body);
    if (!parsed.value) return { hits: [], error: "unparseable JSON", code: "parse_error" };
    const results = parsed.value?.organic ?? [];
    return { hits: results.map((r: any) => ({ url: r.link, title: r.title ?? r.link, snippet: r.snippet })), error: null, code: null };
  },
};

/** Google Programmable Search (Custom Search JSON API). Inert unless key and cx are set. */
export const googleCseBackend: SearchBackend = {
  id: "google-cse",
  label: "Google Programmable Search JSON API",
  configKeys: ["GOOGLE_CSE_KEY", "GOOGLE_CSE_CX"],
  keyFree: false,
  async search(query, limit, req) {
    const key = String(req.env.GOOGLE_CSE_KEY);
    const cx = String(req.env.GOOGLE_CSE_CX);
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(
      cx,
    )}&q=${encodeURIComponent(query)}&num=${Math.min(10, limit)}`;
    const res = await httpFetch(url, { timeoutMs: req.timeoutMs, userAgent: req.userAgent });
    if (!res.ok) return { hits: [], error: res.error, code: res.code };
    const parsed = parseJsonLoose<any>(res.body);
    if (!parsed.value) return { hits: [], error: "unparseable JSON", code: "parse_error" };
    const items = parsed.value?.items ?? [];
    return { hits: items.map((r: any) => ({ url: r.link, title: r.title ?? r.link, snippet: r.snippet })), error: null, code: null };
  },
};

/** Mojeek API. Inert unless MOJEEK_API_KEY is set. */
export const mojeekBackend: SearchBackend = {
  id: "mojeek",
  label: "Mojeek search API",
  configKeys: ["MOJEEK_API_KEY"],
  keyFree: false,
  async search(query, limit, req) {
    const url = `https://www.mojeek.com/search?q=${encodeURIComponent(query)}&fmt=json&t=${Math.min(10, limit)}`;
    const res = await httpFetch(url, {
      timeoutMs: req.timeoutMs,
      userAgent: req.userAgent,
      headers: { Authorization: `Bearer ${req.env.MOJEEK_API_KEY}` },
    });
    if (!res.ok) return { hits: [], error: res.error, code: res.code };
    const parsed = parseJsonLoose<any>(res.body);
    if (!parsed.value) return { hits: [], error: "unparseable JSON", code: "parse_error" };
    const results = parsed.value?.results ?? [];
    return { hits: results.map((r: any) => ({ url: r.url, title: r.title ?? r.url, snippet: r.desc })), error: null, code: null };
  },
};

export const ALL_SEARCH_BACKENDS: SearchBackend[] = [
  hnAlgoliaBackend,
  marginaliaBackend,
  braveBackend,
  tavilyBackend,
  serperBackend,
  googleCseBackend,
  mojeekBackend,
];

export function selectedBackends(env: Env): { backends: SearchBackend[]; notes: string[] } {
  const notes: string[] = [];
  const configured = (env.ALETHEIA_WEBSEARCH_BACKENDS ?? KEY_FREE_BACKENDS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const byId = new Map(ALL_SEARCH_BACKENDS.map((b) => [b.id, b]));
  const selected: SearchBackend[] = [];
  for (const id of configured) {
    const backend = byId.get(id);
    if (!backend) {
      notes.push(`unknown search backend "${id}" ignored`);
      continue;
    }
    const missing = backend.configKeys.filter((k) => !env[k]);
    if (missing.length > 0) {
      notes.push(`backend "${id}" skipped: missing ${missing.join(", ")}`);
      continue;
    }
    selected.push(backend);
  }
  return { backends: selected, notes };
}

/** Pull external result links out of a generic SERP. Markup-tolerant by design. */
export function extractExternalLinks(html: string, excludeHosts: string[], limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (excludeHosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push({ url, title: title || url });
    if (out.length >= limit) break;
  }
  return out;
}

export function createWebSearchAdapter(rubricPath: string): RetrievalAdapter {
  void rubricPath;
  return {
    layer: "retrieval",
    id: "web-search",
    label: "General web search (pluggable backends)",
    description:
      "Queries one or more web-search APIs and then fetches the pages they return. Key-free backends by default; credentialled backends activate only when their key is present.",
    configKeys: ["ALETHEIA_WEBSEARCH_BACKENDS", ...ALL_SEARCH_BACKENDS.flatMap((b) => b.configKeys)],
    available(env: Env): boolean {
      return selectedBackends(env).backends.length > 0;
    },
    async retrieve(req: RetrievalRequest): Promise<AdapterOutcome> {
      const started = Date.now();
      if (req.offline) {
        return unavailableOutcome(this, "disabled", "offline mode (ALETHEIA_OFFLINE=1): network paths disabled", started);
      }
      const { backends, notes } = selectedBackends(req.env);
      if (backends.length === 0) {
        return unavailableOutcome(
          this,
          "unconfigured",
          `no usable search backend. ${notes.join("; ") || "set ALETHEIA_WEBSEARCH_BACKENDS"}`,
          started,
        );
      }

      const backendNotes: string[] = [...notes];
      const candidateUrls: { url: string; title: string; backend: string; publishedAt: string | null }[] = [];
      const seen = new Set<string>();

      // Search APIs want a query, not a sentence. Try the compact question first,
      // then the individual key terms, and keep whichever variant returns hits.
      const variants = queryVariants(req.keywords, 3, genericTermsOf(req.rubric));

      for (const backend of backends) {
        let hits: Awaited<ReturnType<SearchBackend["search"]>>["hits"] = [];
        let error: string | null = null;
        let code: FailureCode | null = null;
        let usedQuery = "";
        for (const variant of variants) {
          const attempt = await backend.search(variant, req.limit, req);
          if (attempt.hits.length > 0) {
            hits = attempt.hits;
            usedQuery = variant;
            error = null;
            code = null;
            break;
          }
          error = attempt.error;
          code = attempt.code;
        }
        if (hits.length === 0) {
          backendNotes.push(`${backend.id}: ${code ?? "error"} - ${error ?? "no results"} (tried: ${variants.join(" | ")})`);
          continue;
        }
        let added = 0;
        for (const hit of hits) {
          if (!hit.url.startsWith("http")) continue;
          const key = hit.url.split("#")[0];
          if (seen.has(key)) continue;
          seen.add(key);
          candidateUrls.push({ url: key, title: hit.title, backend: backend.id, publishedAt: hit.publishedAt ?? null });
          added += 1;
          if (added >= req.limit) break;
        }
        backendNotes.push(`${backend.id}: ${added} candidate URL(s) for query "${usedQuery}"`);
        if (candidateUrls.length >= req.limit * 2) break;
      }

      if (candidateUrls.length === 0) {
        return unavailableOutcome(
          this,
          "empty_result",
          `no backend returned usable results (${backendNotes.join("; ")})`,
          started,
          backendNotes.join("; "),
        );
      }

      const picked = candidateUrls.slice(0, Math.max(req.limit, 3));
      const fetched = await mapLimit(picked, 4, async (cand, i) =>
        fetchDoc({
          url: cand.url,
          id: `W${i + 1}`,
          adapterId: "web-search",
          retrievalDetail: cand.backend,
          discoveredVia: `web-search:${cand.backend}`,
          rubric: req.rubric,
          timeoutMs: req.timeoutMs,
          userAgent: req.userAgent,
          retries: 0,
        }),
      );
      const docs: SourceDoc[] = fetched
        .map((r, i) => {
          if (!r.doc) return null;
          return {
            ...r.doc,
            title: r.doc.title || picked[i].title,
            publishedAt: r.doc.publishedAt ?? picked[i].publishedAt,
            meta: { ...r.doc.meta, searchBackend: picked[i].backend, searchTitle: picked[i].title },
          };
        })
        .filter((d): d is SourceDoc => d !== null);

      const fetchFailures = fetched.filter((r) => r.error).length;
      if (docs.length === 0) {
        return unavailableOutcome(
          this,
          "network_error",
          `search returned ${picked.length} URLs but none could be fetched; ${backendNotes.join("; ")}`,
          started,
          backendNotes.join("; "),
        );
      }
      const outcome = okOutcome(this, docs, started, backendNotes.join("; "));
      if (fetchFailures > 0 || backendNotes.some((n) => /skipped|error|0 candidate/.test(n))) {
        outcome.status = docs.length > 0 ? "partial" : outcome.status;
        outcome.reason = `${fetchFailures} page fetch failure(s); ${backendNotes.join("; ")}`;
      }
      return { ...outcome, docs: docs.map((d, i) => ({ ...d, id: `S${i + 1}` })) };
    },
  };
}

export function backendSummary(env: Env): string {
  const { backends } = selectedBackends(env);
  return backends.map((b) => b.id).join(", ") || "(none configured)";
}

export function backendDomains(env: Env): string[] {
  return selectedBackends(env).backends.map((b) => b.id);
}

export { domainOf };
