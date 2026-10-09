import type { Env } from "../types.ts";
import { envFlag, envInt } from "./util/ids.ts";
import { DEFAULT_USER_AGENT } from "./util/http.ts";

export const DEFAULT_DB_PATH = "aletheia-ledger.db";
export const DEFAULT_RUBRIC_PATH = "rubric/v1.json";

/**
 * Configuration is read once, here, from the environment. No adapter reaches
 * into process.env on its own, and no provider is named anywhere in this file's
 * defaults except as a *default backend list* that can be replaced wholesale via
 * ALETHEIA_WEBSEARCH_BACKENDS.
 */
export interface RawConfig extends Record<string, unknown> {
  dbPath: string;
  databaseUrl: string | null;
  rubricPath: string;
  retrievalAdapterIds: string[];
  timeoutMs: number;
  maxSources: number;
  perAdapterLimit: number;
  userAgent: string;
  offline: boolean;
  env: Env;
  ledgerEnabled: boolean;
}

export function loadConfig(env: Env, overrides: Partial<RawConfig> = {}): RawConfig {
  const dbPath = overrides.dbPath ?? env.ALETHEIA_DB ?? DEFAULT_DB_PATH;
  const databaseUrl = overrides.databaseUrl ?? (env.DATABASE_URL && env.DATABASE_URL.trim() !== "" ? env.DATABASE_URL : null);
  const rubricPath = overrides.rubricPath ?? env.ALETHEIA_RUBRIC ?? DEFAULT_RUBRIC_PATH;
  const retrievalAdapterIds =
    overrides.retrievalAdapterIds ??
    (env.ALETHEIA_RETRIEVAL
      ? env.ALETHEIA_RETRIEVAL.split(",").map((s) => s.trim()).filter(Boolean)
      : []);
  const timeoutMs = overrides.timeoutMs ?? envInt(env, "ALETHEIA_TIMEOUT_MS", 12_000);
  const maxSources = overrides.maxSources ?? envInt(env, "ALETHEIA_MAX_SOURCES", 24);
  const perAdapterLimit = overrides.perAdapterLimit ?? envInt(env, "ALETHEIA_PER_ADAPTER_LIMIT", 5);
  const userAgent = overrides.userAgent ?? env.ALETHEIA_USER_AGENT ?? DEFAULT_USER_AGENT;
  const offline = overrides.offline ?? envFlag(env, "ALETHEIA_OFFLINE");
  const ledgerEnabled = overrides.ledgerEnabled ?? !envFlag(env, "ALETHEIA_NO_LEDGER");
  return {
    dbPath,
    databaseUrl,
    rubricPath,
    retrievalAdapterIds,
    timeoutMs,
    maxSources,
    perAdapterLimit,
    userAgent,
    offline,
    env,
    ledgerEnabled,
  };
}
