import { createHash } from "node:crypto";
import type { Env } from "../types.ts";

export const ENGINE_VERSION = "0.1.0";

/** Deterministic UUID-shaped run id: sha256(question + timestamp + counter). */
export function makeRunId(question: string, timestamp: string, salt = ""): string {
  const h = hashHex(`${question}\u0000${timestamp}\u0000${salt}`).slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

export function hashHex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function sha256(input: string): string {
  return hashHex(input);
}

/**
 * Canonical JSON: object keys sorted, so a hash over the same logical value is
 * stable across runs and across machines. This is what makes ledger
 * verification reproducible by a human with `sha256sum` and a JSON formatter.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function pad(num: number, width: number): string {
  return String(num).padStart(width, "0");
}

/** Round consistently everywhere so recorded numbers match a hand recomputation. */
export function round(value: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function envFlag(env: Env, name: string): boolean {
  const v = env[name];
  if (v === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

export function envCsv(env: Env, name: string): string[] {
  const v = env[name];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function envInt(env: Env, name: string, fallback: number): number {
  const v = env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
