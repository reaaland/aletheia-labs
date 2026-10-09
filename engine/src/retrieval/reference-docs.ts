import type { AdapterOutcome, RetrievalAdapter, RetrievalRequest, SourceDoc } from "../types.ts";
import { makeDoc, mapLimit, okOutcome, unavailableOutcome } from "./common.ts";
import { httpFetch, parseJsonLoose } from "../util/http.ts";
import { collapse, htmlToText, queryVariants, truncate } from "../util/text.ts";
import { genericTermsOf } from "./common.ts";

/**
 * Retrieval path (f): reference-documentation APIs.
 *
 * MDN's search API and MediaWiki's search/extract API both return reference
 * prose plus provenance. They are read-only, anonymous and stable, and they
 * give the rubric a genuine primary-documentation and encyclopaedic source even
 * when no package identifier can be resolved from the question.
 */
export const referenceDocsAdapter: RetrievalAdapter = {
  layer: "retrieval",
  id: "reference-docs",
  label: "Reference documentation APIs (MDN, MediaWiki)",
  description:
    "Reads reference-documentation and encyclopaedia APIs directly. Anonymous, read-only, no key. Provides primary-documentation text when a package identifier cannot be resolved.",
  configKeys: ["ALETHEIA_MEDIAWIKI_API", "ALETHEIA_MEDIAWIKI_LANG"],
  available(): boolean {
    return true;
  },
  async retrieve(req: RetrievalRequest): Promise<AdapterOutcome> {
    const started = Date.now();
    if (req.offline) {
      return unavailableOutcome(this, "disabled", "offline mode (ALETHEIA_OFFLINE=1): network paths disabled", started);
    }
    const docs: SourceDoc[] = [];
    const notes: string[] = [];
    let counter = 0;
    const nextId = () => `D${(counter += 1)}`;
    const variants = queryVariants(req.keywords, 3, genericTermsOf(req.rubric));

    // --- MDN ---------------------------------------------------------------
    let mdnList: any[] = [];
    let mdnStatus: number | null = null;
    let mdnQuery = "";
    let mdnError: string | null = null;
    for (const variant of variants) {
      const res = await httpFetch(
        `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(variant)}&locale=en-US`,
        { timeoutMs: req.timeoutMs, userAgent: req.userAgent, retries: 1 },
      );
      if (!res.ok) {
        mdnError = res.error;
        continue;
      }
      const docs = (parseJsonLoose<any>(res.body).value?.documents ?? []) as any[];
      if (docs.length > 0) {
        mdnList = docs;
        mdnStatus = res.status;
        mdnQuery = variant;
        break;
      }
    }
    if (mdnList.length === 0) {
      notes.push(`mdn: no results${mdnError ? ` (${mdnError})` : ""}`);
    } else {
      const list = mdnList.slice(0, Math.min(3, req.limit));
      notes.push(`mdn: ${list.length} document(s) for "${mdnQuery}"`);
      const fetched = await mapLimit(list, 3, async (doc: any) => {
        const pageUrl = `https://developer.mozilla.org${doc.mdn_url}`;
        const res = await httpFetch(`${pageUrl}?raw`, { timeoutMs: req.timeoutMs, userAgent: req.userAgent });
        const text = res.ok
          ? collapse(htmlToText(res.body))
          : collapse(`${doc.title}. ${doc.summary ?? ""}`);
        return makeDoc(
          nextId(),
          "reference-docs",
          {
            url: pageUrl,
            title: doc.title ?? pageUrl,
            text: truncate(text, 20_000),
            publishedAt: doc.modified ?? null,
            dateSource: doc.modified ? "source_metadata" : "unknown",
            retrievalDetail: "mdn",
            discoveredVia: `reference-docs:mdn search (query "${mdnQuery}")`,
            httpStatus: mdnStatus,
            meta: { popularity: doc.popularity ?? null, slug: doc.slug ?? null },
          },
          req.rubric,
        );
      });
      docs.push(...fetched);
    }

    // --- MediaWiki (Wikipedia by default; any MediaWiki API via env) --------
    const apiBase = req.env.ALETHEIA_MEDIAWIKI_API ?? "https://en.wikipedia.org/w/api.php";
    let wikiHits: any[] = [];
    let wikiQuery = "";
    let wikiError: string | null = null;
    for (const variant of variants) {
      const searchParams = new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: variant,
        format: "json",
        srlimit: String(Math.min(3, req.limit)),
        origin: "*",
      });
      const res = await httpFetch(`${apiBase}?${searchParams.toString()}`, {
        timeoutMs: req.timeoutMs,
        userAgent: req.userAgent,
        retries: 1,
      });
      if (!res.ok) {
        wikiError = res.error;
        continue;
      }
      const found = (parseJsonLoose<any>(res.body).value?.query?.search ?? []) as any[];
      if (found.length > 0) {
        wikiHits = found;
        wikiQuery = variant;
        break;
      }
    }
    if (wikiHits.length === 0) {
      notes.push(`mediawiki: no results${wikiError ? ` (${wikiError})` : ""}`);
    } else {
      const hits = wikiHits.slice(0, Math.min(2, req.limit));
      notes.push(`mediawiki: ${hits.length} page(s) for "${wikiQuery}"`);
      const fetched = await mapLimit(hits, 2, async (hit: any) => {
        const extractParams = new URLSearchParams({
          action: "query",
          prop: "extracts",
          explaintext: "1",
          titles: hit.title,
          format: "json",
          redirects: "1",
          origin: "*",
        });
        const res = await httpFetch(`${apiBase}?${extractParams.toString()}`, {
          timeoutMs: req.timeoutMs,
          userAgent: req.userAgent,
        });
        const data = parseJsonLoose<any>(res.body).value;
        const pages = data?.query?.pages ?? {};
        const first = Object.values(pages)[0] as any;
        const extract = first?.extract ?? collapse(htmlToText(hit.snippet ?? ""));
        const pageUrl = apiBase.includes("wikipedia.org")
          ? `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`
          : `${apiBase}?curid=${first?.pageid ?? ""}`;
        return makeDoc(
          nextId(),
          "reference-docs",
          {
            url: pageUrl,
            title: hit.title,
            text: truncate(collapse(extract), 20_000),
            publishedAt: hit.timestamp ?? null,
            dateSource: hit.timestamp ? "source_metadata" : "unknown",
            retrievalDetail: "mediawiki",
            discoveredVia: `reference-docs:mediawiki search (query "${wikiQuery}")`,
            httpStatus: res.status,
            meta: { pageid: first?.pageid ?? null, wordcount: hit.wordcount ?? null },
          },
          req.rubric,
        );
      });
      docs.push(...fetched);
    }

    if (docs.length === 0) {
      return unavailableOutcome(this, "empty_result", `no reference documents found (${notes.join("; ")})`, started, notes.join("; "));
    }
    const outcome = okOutcome(this, docs, started, notes.join("; "));
    if (notes.some((n) => /error|failed|: /.test(n) && /mdn:|mediawiki:/.test(n) && !/document\(s\)|page\(s\)$/.test(n))) {
      outcome.status = "partial";
      outcome.reason = notes.join("; ");
    }
    return { ...outcome, docs: docs.map((d, i) => ({ ...d, id: `S${i + 1}` })) };
  },
};
