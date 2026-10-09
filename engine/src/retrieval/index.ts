import type { Env, RetrievalAdapter } from "../types.ts";
import { directUrlAdapter } from "./direct-url.ts";
import { createWebSearchAdapter } from "./web-search.ts";
import { packageRegistryAdapter } from "./package-registry.ts";
import { codeHostAdapter, qaForumAdapter } from "./code-host-qa.ts";
import { referenceDocsAdapter } from "./reference-docs.ts";

/**
 * The retrieval registry. Adding a provider = adding an adapter here (or passing
 * one in). The pipeline never special-cases an adapter id.
 */
export function allRetrievalAdapters(): RetrievalAdapter[] {
  return [
    directUrlAdapter,
    createWebSearchAdapter("rubric/v1.json"),
    packageRegistryAdapter,
    codeHostAdapter,
    qaForumAdapter,
    referenceDocsAdapter,
  ];
}

export function selectRetrievalAdapters(ids: string[], extra: RetrievalAdapter[] = []): RetrievalAdapter[] {
  const all = [...allRetrievalAdapters(), ...extra];
  if (ids.length === 0) return all;
  const byId = new Map(all.map((a) => [a.id, a]));
  const out: RetrievalAdapter[] = [];
  for (const id of ids) {
    const adapter = byId.get(id);
    if (adapter) out.push(adapter);
  }
  return out;
}

export function describeAdapters(env: Env, extra: RetrievalAdapter[] = []): string {
  const rows = [...allRetrievalAdapters(), ...extra].map((a) => {
    const available = a.available(env);
    const missing = a.configKeys.filter((k) => !env[k]);
    return `${a.id.padEnd(20)} ${available ? "available" : "unavailable"}  ${a.label}${
      missing.length ? `  [optional config: ${missing.join(", ")}]` : ""
    }`;
  });
  return rows.join("\n");
}

export {
  directUrlAdapter,
  packageRegistryAdapter,
  codeHostAdapter,
  qaForumAdapter,
  referenceDocsAdapter,
  createWebSearchAdapter,
};
