/**
 * Driver selection. No driver is load-bearing: the registry lists every
 * implementation that can run on this machine, and the caller falls through the
 * list at LAUNCH time, so a driver that claims to be available but cannot
 * actually start does not kill the run -- the failure is recorded and the next
 * independent implementation is tried.
 */
import type { Env } from "../types.ts";
import { cdpDriver } from "./cdp-driver.ts";
import { playwrightDriver } from "./playwright-driver.ts";
import type { DriverDescriptor } from "./driver.ts";

export function allBrowserDrivers(): DriverDescriptor[] {
  return [playwrightDriver, cdpDriver];
}

/**
 * Order the drivers to try. `requested` may be a driver id (then only that one
 * is tried and a failure is fatal, because the operator asked for it) or
 * "auto"/null, which puts every available driver in order.
 */
export function driverCandidates(env: Env, requested: string | null): { candidates: DriverDescriptor[]; notes: string[] } {
  const all = allBrowserDrivers();
  const notes: string[] = [];
  const wanted = (requested ?? env.ALETHEIA_BROWSER_DRIVER ?? "auto").trim().toLowerCase();
  if (wanted === "" || wanted === "auto") {
    const available: DriverDescriptor[] = [];
    for (const d of all) {
      const a = d.availability(env);
      notes.push(`browser driver ${d.id}: ${a.available ? "available" : `unavailable (${a.reason})`}`);
      if (a.available) available.push(d);
    }
    if (available.length === 0) throw new Error("no browser driver is available on this machine: install nothing required, but a Chromium-family browser must exist");
    return { candidates: available, notes };
  }
  const found = all.find((d) => d.id === wanted);
  if (!found) {
    throw new Error(`unknown browser driver "${wanted}"; known drivers: ${all.map((d) => d.id).join(", ")}`);
  }
  const a = found.availability(env);
  notes.push(`browser driver ${found.id}: requested explicitly, ${a.available ? "available" : `unavailable (${a.reason})`}`);
  return { candidates: [found], notes };
}
