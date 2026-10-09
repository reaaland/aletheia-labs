import type { AdapterOutcome, RetrievalAdapter, RetrievalRequest, SourceDoc } from "../types.ts";
import { makeDoc, mapLimit, okOutcome, unavailableOutcome } from "./common.ts";
import { httpFetch, parseJsonLoose } from "../util/http.ts";
import { queryVariants, truncate } from "../util/text.ts";
import { genericTermsOf } from "./common.ts";

/**
 * Retrieval path (d): a source-code host's API.
 *
 * GitHub's API is queried anonymously (no token needed for low volume; a token
 * is picked up if present, which only raises the rate limit). Issues, pull
 * requests and releases are where maintainers state breaking changes in their
 * own words, so this path produces first-party changelog-grade evidence that a
 * web index cannot reliably surface.
 */
export const codeHostAdapter: RetrievalAdapter = {
  layer: "retrieval",
  id: "code-host",
  label: "Source-code host API (issues, releases)",
  description:
    "Searches a code host's issue/PR/release index for the question's terms and reads maintainer-written text: release notes, breaking-change announcements, maintainer comments.",
  configKeys: ["GITHUB_TOKEN"],
  available(): boolean {
    return true;
  },
  async retrieve(req: RetrievalRequest): Promise<AdapterOutcome> {
    const started = Date.now();
    if (req.offline) {
      return unavailableOutcome(this, "disabled", "offline mode (ALETHEIA_OFFLINE=1): network paths disabled", started);
    }
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (req.env.GITHUB_TOKEN) headers.authorization = `Bearer ${req.env.GITHUB_TOKEN}`;

    const variants = queryVariants(req.keywords, 3, genericTermsOf(req.rubric));
    const notes: string[] = [];
    const docs: SourceDoc[] = [];
    let counter = 0;
    const nextId = () => `G${(counter += 1)}`;

    // 1. Issues and pull requests: maintainer discussion of the change itself.
    const issueRes = await searchWithVariants(
      (q) => `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(6, req.limit)}&sort=relevance`,
      variants,
      (q) => httpFetch(q, { timeoutMs: req.timeoutMs, userAgent: req.userAgent, headers, retries: 1 }),
      (body) => (parseJsonLoose<any>(body).value?.items ?? []) as any[],
      notes,
      "issue search",
    );
    if (!issueRes.ok) {
      notes.push(`issue search failed: ${issueRes.code ?? "error"} ${issueRes.error}`);
    } else {
      const items = issueRes.items.slice(0, req.limit);
      notes.push(`issue/PR search: ${items.length} hit(s) for "${issueRes.query}"`);
      for (const item of items) {
        const text = [
          `GitHub issue/PR "${item.title}" in ${item.repository_url?.split("/repos/")[1] ?? "unknown repository"}.`,
          item.state ? `State: ${item.state}.` : "",
          item.created_at ? `Opened ${item.created_at}.` : "",
          item.closed_at ? `Closed ${item.closed_at}.` : "",
          typeof item.body === "string" ? item.body : "",
        ]
          .filter(Boolean)
          .join("\n");
        docs.push(
          makeDoc(
            nextId(),
            "code-host",
            {
              url: item.html_url,
              title: item.title ?? item.html_url,
              text: truncate(text, 20_000),
              publishedAt: item.updated_at ?? item.created_at ?? null,
              dateSource: "source_metadata",
              retrievalDetail: "github-issues",
              discoveredVia: "code-host:github issue/PR search",
              httpStatus: issueRes.status,
              meta: { repo: item.repository_url?.split("/repos/")[1] ?? null, kind: "issue", number: item.number ?? null },
            },
            req.rubric,
          ),
        );
      }
    }

    // 2. Releases: first-party changelog text.
    const repoRes = await searchWithVariants(
      (q) => `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${Math.min(3, req.limit)}&sort=stars`,
      variants,
      (q) => httpFetch(q, { timeoutMs: req.timeoutMs, userAgent: req.userAgent, headers }),
      (body) => (parseJsonLoose<any>(body).value?.items ?? []) as any[],
      notes,
      "repo search",
    );
    const repos: any[] = repoRes.ok ? repoRes.items.slice(0, 2) : [];
    if (!repoRes.ok) notes.push(`repo search failed: ${repoRes.code ?? "error"} ${repoRes.error}`);
    for (const repo of repos) {
      const relRes = await httpFetch(`https://api.github.com/repos/${repo.full_name}/releases?per_page=3`, {
        timeoutMs: req.timeoutMs,
        userAgent: req.userAgent,
        headers,
      });
      if (!relRes.ok) {
        notes.push(`releases for ${repo.full_name} failed: ${relRes.error}`);
        continue;
      }
      const releases = parseJsonLoose<any[]>(relRes.body).value ?? [];
      for (const rel of releases.slice(0, 2)) {
        const text = [`Release ${rel.tag_name} of ${repo.full_name}, published ${rel.published_at}.`, typeof rel.body === "string" ? rel.body : ""].join("\n");
        docs.push(
          makeDoc(
            nextId(),
            "code-host",
            {
              url: rel.html_url,
              title: `${repo.full_name} release ${rel.tag_name}`,
              text: truncate(text, 20_000),
              publishedAt: rel.published_at ?? null,
              dateSource: "source_metadata",
              retrievalDetail: "github-releases",
              discoveredVia: "code-host:github releases of a matching repository",
              httpStatus: relRes.status,
              meta: { repo: repo.full_name, kind: "release", tag: rel.tag_name },
            },
            req.rubric,
          ),
        );
      }
      notes.push(`releases for ${repo.full_name}: ${releases.length}`);
    }

    if (docs.length === 0) {
      return unavailableOutcome(
        this,
        notes.some((n) => /rate.?limit|403/i.test(n)) ? "rate_limited" : "empty_result",
        `code host returned no usable documents (${notes.join("; ")})`,
        started,
        notes.join("; "),
      );
    }
    const outcome = okOutcome(this, docs, started, notes.join("; "));
    if (notes.some((n) => /failed|rate/.test(n))) {
      outcome.status = "partial";
      outcome.reason = notes.filter((n) => /failed|rate/.test(n)).join("; ");
    }
    return { ...outcome, docs: docs.map((d, i) => ({ ...d, id: `S${i + 1}` })) };
  },
};

/**
 * Retrieval path (e): a technical Q&A corpus.
 *
 * Stack Exchange's API is free and anonymous (300 requests/day without a key,
 * more with one). It is the main place practitioners record what actually
 * happened to them, which is exactly the evidence that can dissent from the
 * official documentation.
 */
export const qaForumAdapter: RetrievalAdapter = {
  layer: "retrieval",
  id: "qa-forum",
  label: "Technical Q&A corpus (Stack Exchange API)",
  description:
    "Reads practitioner-written questions and answers from the Stack Exchange network. Free and anonymous; an optional key only raises the daily quota.",
  configKeys: ["STACKEXCHANGE_KEY"],
  available(): boolean {
    return true;
  },
  async retrieve(req: RetrievalRequest): Promise<AdapterOutcome> {
    const started = Date.now();
    if (req.offline) {
      return unavailableOutcome(this, "disabled", "offline mode (ALETHEIA_OFFLINE=1): network paths disabled", started);
    }
    const notes: string[] = [];
    const docs: SourceDoc[] = [];
    let counter = 0;
    const nextId = () => `Q${(counter += 1)}`;
    const variants = queryVariants(req.keywords, 2, genericTermsOf(req.rubric));
    let items: any[] = [];
    let lastError: string | null = null;
    let usedQuery = "";
    let quota: unknown = "unknown";
    let httpStatus: number | null = null;
    for (const variant of variants) {
      const params = new URLSearchParams({
        order: "desc",
        sort: "relevance",
        q: variant,
        site: req.env.STACKEXCHANGE_SITE ?? "stackoverflow",
        pagesize: String(Math.min(5, req.limit)),
        filter: "withbody",
      });
      if (req.env.STACKEXCHANGE_KEY) params.set("key", String(req.env.STACKEXCHANGE_KEY));
      const res = await httpFetch(`https://api.stackexchange.com/2.3/search/advanced?${params.toString()}`, {
        timeoutMs: req.timeoutMs,
        userAgent: req.userAgent,
        retries: 1,
      });
      if (!res.ok) {
        lastError = res.error;
        continue;
      }
      httpStatus = res.status;
      const parsed = parseJsonLoose<any>(res.body);
      if (parsed.value?.error_message) {
        return unavailableOutcome(this, "rate_limited", `Stack Exchange API: ${parsed.value.error_message}`, started);
      }
      quota = parsed.value?.quota_remaining ?? "unknown";
      const candidate = (parsed.value?.items ?? []) as any[];
      if (candidate.length > 0) {
        items = candidate;
        usedQuery = variant;
        break;
      }
    }
    if (items.length === 0 && lastError) {
      return unavailableOutcome(this, "network_error", `Stack Exchange API: ${lastError}`, started);
    }
    notes.push(`quota_remaining=${quota}${usedQuery ? `, query "${usedQuery}"` : ""}`);

    for (const item of items) {
      const body = stripSeHtml(item.body ?? "");
      const text = [
        `Stack Overflow question "${item.title}" (score ${item.score ?? 0}, ${item.answer_count ?? 0} answer(s)).`,
        item.creation_date ? `Asked ${new Date(item.creation_date * 1000).toISOString()}.` : "",
        item.is_answered ? "The question has an accepted or upvoted answer." : "The question is not marked answered.",
        body,
      ]
        .filter(Boolean)
        .join("\n");
      docs.push(
        makeDoc(
          nextId(),
          "qa-forum",
          {
            url: item.link,
            title: item.title ?? item.link,
            text: truncate(text, 20_000),
            publishedAt: item.creation_date ? new Date(item.creation_date * 1000).toISOString() : null,
            dateSource: item.creation_date ? "source_metadata" : "unknown",
            retrievalDetail: "stackexchange",
                discoveredVia: `qa-forum:stackexchange search (query "${usedQuery}")`,
            httpStatus,
            meta: { score: item.score ?? 0, answers: item.answer_count ?? 0, tags: item.tags ?? [] },
          },
          req.rubric,
        ),
      );
    }

    if (docs.length === 0) {
      return unavailableOutcome(this, "empty_result", "Stack Exchange returned no questions for this query", started, notes.join("; "));
    }
    return { ...okOutcome(this, docs, started, notes.join("; ")), docs: docs.map((d, i) => ({ ...d, id: `S${i + 1}` })) };
  },
};

/**
 * Walk query variants until an endpoint answers. Search APIs answer a compact
 * query or a single token, never a sentence, so every text-index-backed adapter
 * uses this instead of guessing one query string.
 */
export async function searchWithVariants(
  buildUrl: (query: string) => string,
  variants: string[],
  fetchUrl: (url: string) => Promise<{ ok: boolean; status: number | null; body: string; error: string | null; code: any }>,
  pick: (body: string) => any[],
  notes: string[],
  label: string,
): Promise<{ ok: boolean; items: any[]; query: string; code: any; error: string | null }> {
  let lastCode: any = null;
  let lastError: string | null = null;
  for (const variant of variants) {
    const res = await fetchUrl(buildUrl(variant));
    if (!res.ok) {
      lastCode = res.code;
      lastError = res.error;
      continue;
    }
    const items = pick(res.body);
    if (items.length > 0) return { ok: true, items, query: variant, code: null, error: null };
    notes.push(`${label}: 0 results for "${variant}"`);
  }
  return { ok: false, items: [], query: "", code: lastCode, error: lastError ?? "no results for any query variant" };
}

function stripSeHtml(html: string): string {
  return html
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_m, code: string) => `\n${code}\n`)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export { mapLimit };
