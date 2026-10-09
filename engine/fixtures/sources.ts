import type { SourceDoc } from "../src/types.ts";

/**
 * Hand-written source documents used by the tests. They are deliberately shaped
 * like real retrieved pages (primary docs, a changelog, a Q&A answer) and they
 * contain a genuine disagreement, so the conflict path is exercised offline.
 *
 * Sources 1 and 4 contradict each other about the same proposition: that is the
 * case the engine must surface rather than average.
 */
export const fixtures: SourceDoc[] = [
  {
    id: "F1",
    url: "https://nodejs.org/api/deprecations.html",
    title: "Deprecated APIs | Node.js Documentation",
    text: [
      "DEP0040: `node:punycode` module",
      "The `punycode` module is deprecated. Please use a userland alternative instead.",
      "This deprecation is documentation-only and applies since Node.js v21.0.0.",
      "Type: Documentation-only.",
    ].join("\n"),
    publishedAt: "2025-10-01T00:00:00.000Z",
    dateSource: "source_metadata",
    retrievalPath: "direct-url",
    retrievalDetail: "http-get",
    discoveredVia: "user-supplied --source",
    sourceClass: "primary_documentation",
    sourceClassRule: "official-docs-host",
    fetchedAt: "2026-01-02T00:00:00.000Z",
    httpStatus: 200,
    meta: {},
  },
  {
    id: "F2",
    url: "https://registry.npmjs.org/punycode",
    title: "npm registry metadata: punycode",
    text: [
      'npm package "punycode" (registry metadata).',
      "A robust Punycode converter that fully complies to RFC 3492 and RFC 5891.",
      "The latest published version is 2.3.1.",
      'The npm registry does not mark the latest version of "punycode" as deprecated.',
      "Version 2.3.1 was published on 2023-06-01T12:00:00.000Z.",
    ].join("\n"),
    publishedAt: "2023-06-01T12:00:00.000Z",
    dateSource: "source_metadata",
    retrievalPath: "package-registry",
    retrievalDetail: "npm",
    discoveredVia: "package-registry:npm",
    sourceClass: "primary_documentation",
    sourceClassRule: "registry-host",
    fetchedAt: "2026-01-02T00:00:00.000Z",
    httpStatus: 200,
    meta: {},
  },
  {
    id: "F3",
    url: "https://en.wikipedia.org/wiki/Punycode",
    title: "Punycode",
    text: [
      "Punycode is a representation of Unicode with the limited ASCII character subset used for Internet hostnames.",
      "Punycode is defined in RFC 3492 and updated by RFC 5891.",
    ].join("\n"),
    publishedAt: "2025-08-01T00:00:00.000Z",
    dateSource: "source_metadata",
    retrievalPath: "reference-docs",
    retrievalDetail: "mediawiki",
    discoveredVia: "reference-docs:mediawiki search",
    sourceClass: "aggregator",
    sourceClassRule: "aggregator-host",
    fetchedAt: "2026-01-02T00:00:00.000Z",
    httpStatus: 200,
    meta: {},
  },
  {
    id: "F4",
    url: "https://blog.example-vendor.com/2024/node-punycode-is-not-deprecated",
    title: "The Node.js punycode module is not deprecated in practice",
    text: [
      "The built-in punycode module is not deprecated for practical purposes and no migration is required.",
      "The punycode module ships with Node.js and continues to work without changes in every supported release.",
    ].join("\n"),
    publishedAt: "2024-06-01T00:00:00.000Z",
    dateSource: "source_metadata",
    retrievalPath: "web-search",
    retrievalDetail: "hn-algolia",
    discoveredVia: "web-search:hn-algolia",
    sourceClass: "vendor_blog",
    sourceClassRule: "vendor-blog-host",
    fetchedAt: "2026-01-02T00:00:00.000Z",
    httpStatus: 200,
    meta: {},
  },
  {
    id: "F5",
    url: "https://stackoverflow.com/questions/100000/the-punycode-deprecation-warning",
    title: "What does the punycode deprecation warning mean?",
    text: [
      "The punycode deprecation warning means the built-in module is deprecated and you should install the userland punycode package instead.",
      "Many users report the same warning after upgrading to Node.js v21.0.0.",
    ].join("\n"),
    publishedAt: "2024-02-01T00:00:00.000Z",
    dateSource: "source_metadata",
    retrievalPath: "qa-forum",
    retrievalDetail: "stackexchange",
    discoveredVia: "qa-forum:stackexchange search",
    sourceClass: "qa_forum",
    sourceClassRule: "qa-host",
    fetchedAt: "2026-01-02T00:00:00.000Z",
    httpStatus: 200,
    meta: {},
  },
];

export const QUESTION = "Is the built-in punycode module deprecated in Node.js and what replaces it?";
export const RUN_DATE = "2026-01-02T00:00:00.000Z";
