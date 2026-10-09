import type { AdapterOutcome, RetrievalAdapter, RetrievalRequest } from "../types.ts";
import { fetchDoc, mapLimit, okOutcome, unavailableOutcome } from "./common.ts";

/**
 * Retrieval path (a): direct HTTP fetch of URLs the user supplies.
 *
 * No search index, no key, no third party service: the user names the sources
 * and the engine reads them. This is the backbone of the zero-credential path.
 */
export const directUrlAdapter: RetrievalAdapter = {
  layer: "retrieval",
  id: "direct-url",
  label: "Direct URL fetch",
  description: "Fetches URLs supplied with --source over plain HTTP. No search index, no key, no provider.",
  configKeys: [],
  available(): boolean {
    return true;
  },
  async retrieve(req: RetrievalRequest): Promise<AdapterOutcome> {
    const started = Date.now();
    if (req.offline) {
      return unavailableOutcome(this, "disabled", "offline mode (ALETHEIA_OFFLINE=1): network paths disabled", started);
    }
    if (req.urls.length === 0) {
      return unavailableOutcome(
        this,
        "unconfigured",
        "no URLs given: pass one or more --source <url> to use this path",
        started,
      );
    }
    const urls = req.urls.slice(0, Math.max(req.limit, 1) * 2);
    const results = await mapLimit(urls, 4, async (url, i) =>
      fetchDoc({
        url,
        id: `S${i + 1}`,
        adapterId: "direct-url",
        retrievalDetail: "http-get",
        discoveredVia: "user-supplied --source",
        rubric: req.rubric,
        timeoutMs: req.timeoutMs,
        userAgent: req.userAgent,
        retries: 1,
      }),
    );
    const docs = results.map((r) => r.doc).filter((d): d is NonNullable<typeof d> => d !== null);
    const failures = results.filter((r) => r.error);

    if (docs.length === 0) {
      return unavailableOutcome(
        this,
        failures[0]?.code ?? "http_error",
        `all ${failures.length} supplied URL(s) failed; first: ${failures[0]?.error}`,
        started,
        failures.map((f) => f.error).join("; "),
      );
    }

    const outcome = okOutcome(this, docs, started, `${docs.length}/${results.length} URLs fetched`);
    if (failures.length > 0) {
      outcome.status = "partial";
      outcome.reason = `${failures.length} of ${results.length} URLs failed: ${failures[0].error}`;
      outcome.reasonCode = failures[0].code ?? "http_error";
    }
    return { ...outcome, docs: docs.map((d, i) => ({ ...d, id: `S${i + 1}` })) };
  },
};
