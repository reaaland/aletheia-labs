/** Text normalisation helpers. All pure and deterministic. */

const BLOCK_TAGS = [
  "p",
  "div",
  "section",
  "article",
  "li",
  "ul",
  "ol",
  "br",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "header",
  "footer",
];

/** Strip tags/scripts/styles and decode the common entities. Deterministic. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ");
  for (const tag of BLOCK_TAGS) {
    s = s.replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), "\n");
  }
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v\u00a0]+/g, " ");
  s = s.replace(/\n{2,}/g, "\n");
  s = s
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return s.trim();
}

export function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "-",
    mdash: "--",
    hellip: "...",
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
    middot: "*",
    copy: "(c)",
    reg: "(R)",
    trade: "(TM)",
    deg: "deg",
  };
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_m, ent: string) => {
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const code = Number.parseInt(ent.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : _m;
    }
    if (ent.startsWith("#")) {
      const code = Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : _m;
    }
    const key = ent.toLowerCase();
    return named[key] ?? _m;
  });
}

function safeFromCodePoint(code: number): string {
  if (code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Extract <title>. */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) {
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    return h1 ? collapse(decodeEntities(h1[1].replace(/<[^>]+>/g, " "))) : null;
  }
  return collapse(decodeEntities(m[1].replace(/<[^>]+>/g, " ")));
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

/** Registrable-ish domain used for independence counting. No public-suffix list needed. */
export function domainOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    // Handle the common multi-part suffixes without pulling in a public-suffix dependency.
    const twoPartTlds = ["co.uk", "org.uk", "ac.uk", "com.au", "co.jp", "com.br", "co.in", "org.au", "co.nz", "com.cn"];
    const lastTwo = parts.slice(-2).join(".");
    if (twoPartTlds.includes(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
    return lastTwo;
  } catch {
    return url;
  }
}

/**
 * Sentence splitter tuned for technical prose: does not split on version
 * numbers ("2.3.1"), common abbreviations, or inside URLs.
 */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/(https?:\/\/[^\s]+)/g, (m) => m.replace(/\./g, "\u0001"))
    .replace(/\b(\d+)\.(\d+)(\.(\d+))?/g, (_m, a, b, c) => `${a}\u0001${b}${c ? `\u0001${c}` : ""}`)
    .replace(/\b(e\.g|i\.e|etc|vs|Mr|Mrs|Dr|Inc|Ltd|approx|cf|al)\./gi, (_m, a) => `${a}@`);

  const parts = protectedText.split(/(?<=[.!?])["')\]]*\s+(?=[A-Z0-9`*_[(])|\n+/g);
  return parts
    .map((p) => p.replace(/\u0001/g, ".").replace(/@/g, ".").replace(/^\s*[-*+>#]+\s*/, "").trim())
    .filter((p) => p.length > 0);
}

const WORD_RE = /[A-Za-z0-9][A-Za-z0-9._+#-]*/g;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).map((t) => t.replace(/^[._-]+|[._-]+$/g, "")).filter(Boolean);
}

export function significantTerms(text: string, stopwords: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokenize(text)) {
    const t = normalizeTerm(raw);
    if (!t || t.length < 3 || stopwords.has(t)) continue;
    if (/^\d+$/.test(t) && t.length < 3) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Light stemming so "deprecated"/"deprecation"/"deprecate" cluster together. */
export function normalizeTerm(term: string): string {
  let t = term;
  // Identifier-shaped tokens (node.js, @scope/pkg, built-in, v2.3.1) must survive
  // stemming intact: "node.js" -> "node.j" would silently break query building.
  if (/[.@/\d]/.test(term)) return t.toLowerCase();
  t = t.replace(/(ations?|ition|ings?|edly|edness)$/i, "");
  if (t.length > 4) {
    t = t.replace(/(ies)$/i, "y");
    t = t.replace(/(ses|xes|zes|ches|shes)$/i, (m) => m.slice(0, -2));
    t = t.replace(/(ss)$/i, "ss");
    if (/([^s])s$/i.test(t) && !/(ss|us|is)$/i.test(t)) t = t.slice(0, -1);
  }
  if (t.length > 5) t = t.replace(/(ed|ing)$/i, "");
  if (t.length > 5) t = t.replace(/(ate|ation|ment|ness)$/i, "");
  return t;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) n += 1;
  return n;
}

export function excerptAround(text: string, needle: string, radius = 160): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return truncate(text, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  return `${start > 0 ? "..." : ""}${text.slice(start, end).trim()}${end < text.length ? "..." : ""}`;
}

export function stripMarkdown(text: string): string {
  return collapse(
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^[>#*+-]+\s*/gm, " ")
      .replace(/[*_]{1,3}/g, ""),
  );
}

/**
 * Rank the question's terms by how much they look like a discriminating
 * identifier rather than sentence filler, and return the top `n`.
 *
 * Search APIs behave very differently from a human: a full question returns
 * zero hits, while the two or three most specific tokens return plenty. This is
 * the deterministic rule that turns a question into a query.
 */
export function rankKeywords(terms: string[], n: number, generic: Set<string> = new Set()): string[] {
  const scored = terms.map((term, index) => {
    let score = Math.min(term.length, 12);
    if (/[./]/.test(term)) score += 3; // node.js, @scope/pkg, path-like
    if (/-/.test(term)) score += 1;
    if (/\d/.test(term)) score += 2;
    if (term.length <= 3) score -= 4; // "npm", "api" are weak discriminators
    if (generic.has(term)) score -= 6; // "module", "deprecated": present in every question about them
    score -= index * 0.25; // earlier in the question = more likely the subject
    return { term, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, n)
    .map((s) => s.term);
}

/**
 * Query variants for a search API, best first: the compact multi-term query,
 * then each key term alone. APIs that index text (as opposed to answering
 * questions) return nothing for a sentence and plenty for one good token, so
 * the adapters walk this list until something answers.
 */
export function queryVariants(terms: string[], n: number, generic: Set<string> = new Set()): string[] {
  const ranked = rankKeywords(terms, n, generic);
  const out = [ranked.join(" "), ...ranked].map((v) => v.trim()).filter(Boolean);
  return [...new Set(out)];
}

