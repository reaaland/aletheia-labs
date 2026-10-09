import type { AdapterOutcome, RetrievalAdapter, RetrievalRequest, SourceDoc } from "../types.ts";
import { makeDoc, mapLimit, okOutcome, unavailableOutcome } from "./common.ts";
import { httpFetch, parseJsonLoose } from "../util/http.ts";
import { rankKeywords, truncate } from "../util/text.ts";
import { genericTermsOf } from "./common.ts";

/**
 * Retrieval path (c): structured package registries.
 *
 * This is structurally different from a web index: the engine resolves an
 * identifier (a package name) and reads typed metadata a registry is obligated
 * to publish -- latest version, deprecation flags, yank status, release dates.
 * Registries are queried directly and anonymously over public JSON endpoints.
 *
 * Backends are selected with ALETHEIA_REGISTRY_BACKENDS (npm, pypi, maven).
 */
const DEFAULT_BACKENDS = ["npm", "pypi", "maven"];

export function candidatePackageNames(keywords: string[], question: string, generic: Set<string> = new Set()): string[] {
  const fromQuotes = [...question.matchAll(/[`"']([a-zA-Z0-9_.@/-]{3,40})[`"']/g)].map((m) => m[1]);
  const scoped = [...question.matchAll(/@[a-z0-9-]+\/[a-z0-9-]{2,}/gi)].map((m) => m[0]);
  // Explicitly quoted or scoped names first (the user named them), then the
  // question's most discriminating terms, ranked so filler words come last.
  const merged = [...scoped, ...fromQuotes, ...rankKeywords(keywords, 3, generic)];
  const out: string[] = [];
  for (const raw of merged) {
    const name = raw.trim().replace(/^['"`]|['"`]$/g, "");
    if (name.length < 3) continue;
    if (/^\d+$/.test(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= 4) break;
  }
  return out;
}

async function npmBackend(req: RetrievalRequest, out: SourceDoc[], nextId: () => string): Promise<string[]> {
  const notes: string[] = [];
  const names = candidatePackageNames(req.keywords, req.question, genericTermsOf(req.rubric));
  if (names.length === 0) return ["npm: no candidate identifiers in the question"];

  // A registry search will happily return unrelated packages, so a hit is only
  // accepted when its name actually contains one of the question's identifiers.
  const search = await httpFetch(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(names.join(" "))}&size=${Math.min(8, req.limit * 2)}`,
    { timeoutMs: req.timeoutMs, userAgent: req.userAgent, retries: 1 },
  );
  const found: string[] = [...names];
  const identifiers = names.map((n) => n.replace(/^@[^/]+\//, "").replace(/[^a-z0-9]/gi, "").toLowerCase()).filter((n) => n.length >= 4);
  if (search.ok) {
    const parsed = parseJsonLoose<any>(search.body);
    for (const obj of parsed.value?.objects ?? []) {
      const name = obj?.package?.name;
      if (typeof name !== "string" || found.includes(name)) continue;
      const flat = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (!identifiers.some((id) => flat.includes(id) || id.includes(flat))) {
        notes.push(`npm search: dropped unrelated hit "${name}"`);
        continue;
      }
      found.push(name);
    }
  } else {
    notes.push(`npm search failed: ${search.error}`);
  }

  const targets = found.slice(0, 3);
  const docs = await mapLimit(targets, 3, async (name) => {
    const res = await httpFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      timeoutMs: req.timeoutMs,
      userAgent: req.userAgent,
    });
    if (!res.ok) return { name, doc: null as SourceDoc | null, error: res.error };
    const parsed = parseJsonLoose<any>(res.body);
    if (!parsed.value || typeof parsed.value !== "object") return { name, doc: null, error: "unparseable registry JSON" };
    const pkg = parsed.value as any;
    const latestTag = pkg["dist-tags"]?.latest;
    const latest = latestTag ? pkg.versions?.[latestTag] : undefined;
    const versionTimes = Object.keys(pkg.time ?? {}).filter((k) => k !== "created" && k !== "modified");
    const latestTime = latestTag ? pkg.time?.[latestTag] : undefined;
    const deprecatedMessage = latest?.deprecated ?? pkg.versions?.[latestTag]?.deprecated ?? null;
    const lines = [
      `npm package "${pkg.name}" (registry metadata, fetched ${new Date().toISOString()}).`,
      pkg.description ? `Description: ${pkg.description}.` : "",
      latestTag ? `The latest published version is ${latestTag}.` : "No published version is recorded.",
      deprecationSentence(name, deprecatedMessage),
      latestTime ? `Version ${latestTag} was published on ${latestTime}.` : "",
      versionTimes.length ? `The package has ${versionTimes.length} published versions.` : "",
      pkg.license ? `License: ${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license)}.` : "",
      pkg.homepage ? `Homepage: ${pkg.homepage}.` : "",
      Array.isArray(pkg.keywords) && pkg.keywords.length ? `Keywords: ${pkg.keywords.slice(0, 12).join(", ")}.` : "",
      pkg.repository?.url ? `Repository: ${String(pkg.repository.url).replace(/^git\+/, "").replace(/\.git$/, "")}.` : "",
    ].filter(Boolean);
    const doc = makeDoc(
      nextId(),
      "package-registry",
      {
        url: `https://registry.npmjs.org/${encodeURIComponent(name)}`,
        title: `npm registry metadata: ${name}`,
        text: truncate(lines.join("\n"), 20_000),
        publishedAt: latestTime ?? pkg.time?.modified ?? null,
        dateSource: latestTime ? "source_metadata" : "unknown",
        retrievalDetail: "npm",
        discoveredVia: `package-registry:npm (identifier resolved from the question)`,
        httpStatus: res.status,
        meta: { package: name, latestVersion: latestTag ?? null, deprecated: deprecatedMessage ?? null, registry: "npm" },
      },
      req.rubric,
    );
    return { name, doc, error: null as string | null };
  });

  for (const d of docs) {
    if (d.doc) out.push(d.doc);
    else notes.push(`npm ${d.name}: ${d.error}`);
  }
  return [`npm: ${docs.filter((d) => d.doc).length}/${targets.length} package record(s)`].concat(notes);
}

function deprecationSentence(name: string, message: string | null): string {
  if (message) {
    return `The npm registry marks the latest version of "${name}" as deprecated, with the message: ${message}.`;
  }
  return `The npm registry does not mark the latest version of "${name}" as deprecated.`;
}

async function pypiBackend(req: RetrievalRequest, out: SourceDoc[], nextId: () => string): Promise<string[]> {
  const notes: string[] = [];
  const names = candidatePackageNames(req.keywords, req.question, genericTermsOf(req.rubric)).map((n) => n.replace(/^@[^/]+\//, "").split("@")[0]);
  const targets = names.slice(0, 3);
  const results = await mapLimit(targets, 3, async (name) => {
    const res = await httpFetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      timeoutMs: req.timeoutMs,
      userAgent: req.userAgent,
    });
    if (!res.ok) return { name, doc: null as SourceDoc | null, error: res.error };
    const parsed = parseJsonLoose<any>(res.body);
    if (!parsed.value?.info) return { name, doc: null, error: "unparseable PyPI JSON" };
    const info = parsed.value.info;
    const releases = Object.keys(parsed.value.releases ?? {});
    const yanked = info.yanked === true || (info.yanked_reason ? true : false);
    const lines = [
      `Python package "${info.name}" (PyPI metadata).`,
      info.summary ? `Summary: ${info.summary}.` : "",
      info.version ? `The latest version on PyPI is ${info.version}.` : "",
      yanked
        ? `PyPI marks this release as yanked${info.yanked_reason ? `: ${info.yanked_reason}` : ""}.`
        : `PyPI does not mark the latest release as yanked.`,
      info.requires_python ? `Requires Python ${info.requires_python}.` : "",
      releases.length ? `PyPI records ${releases.length} release(s).` : "",
      info.project_url ? `Project page: ${info.project_url}.` : "",
    ].filter(Boolean);
    const doc = makeDoc(
      nextId(),
      "package-registry",
      {
        url: `https://pypi.org/project/${encodeURIComponent(name)}/`,
        title: `PyPI metadata: ${info.name ?? name}`,
        text: truncate(lines.join("\n"), 20_000),
        publishedAt: null,
        dateSource: "unknown",
        retrievalDetail: "pypi",
        discoveredVia: "package-registry:pypi (identifier resolved from the question)",
        httpStatus: res.status,
        meta: { package: name, latestVersion: info.version ?? null, yanked, registry: "pypi" },
      },
      req.rubric,
    );
    return { name, doc, error: null as string | null };
  });
  for (const r of results) {
    if (r.doc) out.push(r.doc);
    else notes.push(`pypi ${r.name}: ${r.error}`);
  }
  return [`pypi: ${results.filter((r) => r.doc).length}/${targets.length} package record(s)`].concat(notes);
}

async function mavenBackend(req: RetrievalRequest, out: SourceDoc[], nextId: () => string): Promise<string[]> {
  const names = candidatePackageNames(req.keywords, req.question, genericTermsOf(req.rubric));
  if (names.length === 0) return ["maven: no candidate identifiers"];
  const q = names[0];
  const res = await httpFetch(
    `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(q)}&rows=5&wt=json`,
    { timeoutMs: req.timeoutMs, userAgent: req.userAgent },
  );
  if (!res.ok) return [`maven: ${res.error}`];
  const parsed = parseJsonLoose<any>(res.body);
  const identifiers = names.map((n) => n.replace(/[^a-z0-9]/gi, "").toLowerCase()).filter((n) => n.length >= 4);
  const entries = (parsed.value?.response?.docs ?? []).filter((e: any) => {
    const flat = `${e.g ?? ""}${e.a ?? ""}`.replace(/[^a-z0-9]/gi, "").toLowerCase();
    // Only a coordinate that actually contains one of the question's identifiers
    // counts; Maven's search will otherwise return anything vaguely similar.
    return identifiers.some((id) => flat.includes(id));
  });
  if (entries.length === 0) return ["maven: no artifact matched the question's identifiers"];
  const lines = entries.map(
    (e: any) => `Maven artifact ${e.g}:${e.a} latest version ${e.latestVersion ?? e.v ?? "unknown"}${e.timestamp ? ` (timestamp ${new Date(Number(e.timestamp)).toISOString()})` : ""}.`,
  );
  out.push(
    makeDoc(
      nextId(),
      "package-registry",
      {
        url: `https://search.maven.org/search?q=${encodeURIComponent(q)}`,
        title: `Maven Central search: ${q}`,
        text: lines.join("\n"),
        publishedAt: null,
        dateSource: "unknown",
        retrievalDetail: "maven",
        discoveredVia: "package-registry:maven",
        httpStatus: res.status,
        meta: { registry: "maven", query: q },
      },
      req.rubric,
    ),
  );
  return [`maven: ${entries.length} artifact(s)`];
}

export const packageRegistryAdapter: RetrievalAdapter = {
  layer: "retrieval",
  id: "package-registry",
  label: "Package registries (npm, PyPI, Maven)",
  description:
    "Resolves package identifiers from the question and reads authoritative registry metadata directly: versions, deprecation flags, yank status, release dates.",
  configKeys: ["ALETHEIA_REGISTRY_BACKENDS"],
  available(env): boolean {
    const sel = (env.ALETHEIA_REGISTRY_BACKENDS ?? DEFAULT_BACKENDS.join(",")).split(",").map((s) => s.trim());
    return sel.some((s) => DEFAULT_BACKENDS.includes(s));
  },
  async retrieve(req: RetrievalRequest): Promise<AdapterOutcome> {
    const started = Date.now();
    if (req.offline) {
      return unavailableOutcome(this, "disabled", "offline mode (ALETHEIA_OFFLINE=1): network paths disabled", started);
    }
    const selected = (req.env.ALETHEIA_REGISTRY_BACKENDS ?? DEFAULT_BACKENDS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter((s) => DEFAULT_BACKENDS.includes(s));
    if (selected.length === 0) {
      return unavailableOutcome(this, "unconfigured", "no registry backend selected", started);
    }

    const docs: SourceDoc[] = [];
    let counter = 0;
    const nextId = () => `R${(counter += 1)}`;
    const notes: string[] = [];

    if (selected.includes("npm")) notes.push(...(await npmBackend(req, docs, nextId)));
    if (selected.includes("pypi")) notes.push(...(await pypiBackend(req, docs, nextId)));
    if (selected.includes("maven")) notes.push(...(await mavenBackend(req, docs, nextId)));

    if (docs.length === 0) {
      return unavailableOutcome(this, "empty_result", `no registry returned usable metadata (${notes.join("; ")})`, started, notes.join("; "));
    }
    const outcome = okOutcome(this, docs, started, notes.join("; "));
    if (notes.some((n) => /failed|error|no candidate/.test(n))) {
      outcome.status = "partial";
      outcome.reason = notes.filter((n) => /failed|error|no candidate/.test(n)).join("; ");
    }
    return { ...outcome, docs: docs.map((d, i) => ({ ...d, id: `S${i + 1}` })) };
  },
};
