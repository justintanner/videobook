import type { SearchHit } from "videobook-engine";

// Engine hit scores are reciprocal-rank values, so they only order hits within
// a single book. Ranking across books must use the per-signal similarity
// scores, which are comparable because every book shares the same embedding
// spaces; exact and near fingerprint matches outrank any similarity.
export function comparableHitScore(hit: Pick<SearchHit, "signals">): number {
  let boost = 0;
  let strongest = 0;
  for (const signal of hit.signals) {
    if (signal.kind === "exact") boost = Math.max(boost, 1);
    else if (signal.kind === "near") boost = Math.max(boost, 0.25);
    else strongest = Math.max(strongest, Math.min(signal.score ?? 0, 1));
  }
  return Math.min(boost + strongest, 1);
}
