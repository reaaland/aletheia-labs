import type { ReasoningAdapter, ReasoningRequest, ReasoningResult } from "../types.ts";
import { heuristicReasoner } from "./heuristic.ts";

/**
 * The reasoning registry.
 *
 * This layer has exactly one implementation, and it is deterministic: fixed
 * templates over the graded evidence. No network, no credential, no model.
 *
 * The `ReasoningAdapter` interface is kept because the prose layer is
 * conceptually separate from grading and because one implementation behind an
 * interface is easier to test — but nothing else implements it, nothing can be
 * selected into it at runtime, and no code path in this engine can reach a
 * model. Adding one would mean editing this file, which is exactly the property
 * an auditor needs: absence that can be confirmed by reading the source rather
 * than by trusting configuration.
 */
export function allReasoningAdapters(): ReasoningAdapter[] {
  return [heuristicReasoner];
}

export function selectReasoningAdapter(id: string): ReasoningAdapter {
  return allReasoningAdapters().find((a) => a.id === id) ?? heuristicReasoner;
}

/**
 * Produce the verdict prose. Total: an unknown id resolves to the one
 * deterministic reasoner rather than throwing, so a run can never fail
 * because of the prose layer.
 */
export async function synthesizeReasoning(req: ReasoningRequest): Promise<ReasoningResult> {
  return selectReasoningAdapter(heuristicReasoner.id).synthesize(req);
}

export { heuristicReasoner };
