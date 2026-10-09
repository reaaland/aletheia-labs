import type { AdapterOutcome, FailureCode, RetrievalAdapter, SourceClass, SourceDoc } from "../types.ts";
import { nowIso } from "../util/ids.ts";
import { httpFetch, guessDate, type FetchOptions } from "../util/http.ts";
import { classifySource } from "../grade/rubric.ts";
import type { Rubric } from "../types.ts";
import { collapse, extractTitle, htmlToText, truncate } from "../util/text.ts";

export interface DocDraft {
  url: string;
  title: string;
  text: string;
  publishedAt?: string | null;
  dateSource?: SourceDoc["dateSource"];
  retrievalDetail: string;
  discoveredVia: string;
  httpStatus?: number | null;
  meta?: Record<string, unknown>;
}

export function makeDoc(id: string, adapterId: string, draft: DocDraft, rubric: Rubric, fetchedAt = nowIso()): SourceDoc {
  const { sourceClass, ruleId } = classifySource(draft.url, rubric);
  return {
    id,
    url: draft.url,
    title: draft.title || draft.url,
    text: draft.text,
    publishedAt: draft.publishedAt ?? null,
    dateSource: draft.dateSource ?? (draft.publishedAt ? "source_metadata" : "unknown"),
    retrievalPath: adapterId,
    retrievalDetail: draft.retrievalDetail,
    discoveredVia: draft.discoveredVia,
    sourceClass: sourceClass as SourceClass,
    sourceClassRule: ruleId,
    fetchedAt,
    httpStatus: draft.httpStatus ?? null,
    meta: draft.meta ?? {},
  };
}

/** The rubric's generic-query-word list, as a set, for query construction. */
export function genericTermsOf(rubric: Rubric): Set<string> {
  return new Set((rubric.selection?.genericQueryTerms ?? []).map((t) => t.toLowerCase()));
}

export function okOutcome(a: RetrievalAdapter, docs: SourceDoc[], startedAt: number, detail: string | null = null): AdapterOutcome {
  return {
    adapter: a.id,
    label: a.label,
    layer: "retrieval",
    status: docs.length > 0 ? "ok" : "unavailable",
    reason: docs.length > 0 ? null : "adapter ran but produced no usable sources",
    reasonCode: docs.length > 0 ? null : "empty_result",
    requiredConfig: a.configKeys,
    docs,
    durationMs: Date.now() - startedAt,
    detail,
  };
}

export function unavailableOutcome(
  a: RetrievalAdapter,
  code: FailureCode,
  reason: string,
  startedAt: number,
  detail: string | null = null,
): AdapterOutcome {
  return {
    adapter: a.id,
    label: a.label,
    layer: "retrieval",
    status: code === "unconfigured" || code === "disabled" ? "unavailable" : "failed",
    reason,
    reasonCode: code,
    requiredConfig: a.configKeys,
    docs: [],
    durationMs: Date.now() - startedAt,
    detail,
  };
}

/** Fetch one URL and normalise it into a SourceDoc. Never throws. */
export async function fetchDoc(args: {
  url: string;
  id: string;
  adapterId: string;
  retrievalDetail: string;
  discoveredVia: string;
  rubric: Rubric;
  timeoutMs: number;
  userAgent: string;
  headers?: Record<string, string>;
  acceptHtml?: boolean;
  /** Called for JSON endpoints that want to shape the text themselves. */
  transform?: (body: string, res: Awaited<ReturnType<typeof httpFetch>>) => DocDraft | null;
  retries?: number;
}): Promise<{ doc: SourceDoc | null; error: string | null; code: FailureCode | null; status: number | null }> {
  const opts: FetchOptions = {
    timeoutMs: args.timeoutMs,
    userAgent: args.userAgent,
    headers: args.headers,
    retries: args.retries ?? 0,
  };
  const res = await httpFetch(args.url, opts);
  if (!res.ok) return { doc: null, error: res.error, code: res.code, status: res.status };

  if (args.transform) {
    const draft = args.transform(res.body, res);
    if (!draft) return { doc: null, error: "response could not be parsed into a document", code: "parse_error", status: res.status };
    return { doc: makeDoc(args.id, args.adapterId, draft, args.rubric), error: null, code: null, status: res.status };
  }

  const contentType = res.contentType ?? "";
  const looksHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(res.body.slice(0, 200));
  const text = looksHtml ? htmlToText(res.body) : collapse(res.body);
  const title = looksHtml ? (extractTitle(res.body) ?? args.url) : firstLine(res.body) ?? args.url;
  const guessed = guessDate(text.slice(0, 4000));
  const publishedAt = res.lastModified ? new Date(res.lastModified).toISOString() : guessed.date;
  const dateSource: SourceDoc["dateSource"] = res.lastModified
    ? "http_header"
    : guessed.source === "source_metadata"
      ? "source_metadata"
      : "unknown";

  return {
    doc: makeDoc(
      args.id,
      args.adapterId,
      {
        url: args.url,
        title,
        text: truncate(text, 40_000),
        publishedAt,
        dateSource,
        retrievalDetail: args.retrievalDetail,
        discoveredVia: args.discoveredVia,
        httpStatus: res.status,
        meta: { contentType: res.contentType },
      },
      args.rubric,
    ),
    error: null,
    code: null,
    status: res.status,
  };
}

function firstLine(body: string): string | null {
  const line = body.split("\n").map((l) => l.trim()).find(Boolean);
  return line ? truncate(line, 120) : null;
}

/** Run a list of async jobs with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
