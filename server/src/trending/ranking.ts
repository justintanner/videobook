import type { RankedVideo, Sighting, TrendingSchedule } from "./types.js";

export interface RankingOptions {
  cutAt: string;
  fallback?: readonly Sighting[];
  organicVideoIds?: ReadonlySet<string>;
}

function compareViews(left: RankedVideo, right: RankedVideo): number {
  return right.metrics.views - left.metrics.views
    || right.sources.length - left.sources.length
    || right.metrics.likes - left.metrics.likes
    || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.videoId.localeCompare(right.videoId);
}

function rankCandidates(sightings: readonly Sighting[], method: TrendingSchedule["ranking"]): RankedVideo[] {
  const byId = new Map<string, RankedVideo>();
  const orders = new Map<string, Map<string, number>>();
  for (const sighting of sightings) {
    const previous = byId.get(sighting.videoId);
    const sources = [...new Set([...(previous?.sources ?? []), sighting.source])].sort();
    const best = previous && previous.metrics.views >= sighting.metrics.views ? previous : sighting;
    byId.set(sighting.videoId, { ...best, sources, rank: 0, fallback: false });
    const source = orders.get(sighting.source) ?? new Map<string, number>();
    source.set(sighting.videoId, Math.min(source.get(sighting.videoId) ?? Infinity, sighting.sourceRank));
    orders.set(sighting.source, source);
  }
  const points = new Map<string, number>();
  for (const source of orders.values()) {
    const ordered = [...source].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    ordered.forEach(([id], index) => points.set(id, (points.get(id) ?? 0) + ordered.length - index));
  }
  return [...byId.values()].sort((left, right) => method === "views"
    ? compareViews(left, right)
    : (points.get(right.videoId) ?? 0) - (points.get(left.videoId) ?? 0)
      || right.metrics.views - left.metrics.views || compareViews(left, right));
}

export function rankVideos(
  sightings: readonly Sighting[],
  schedule: TrendingSchedule,
  options: RankingOptions,
): RankedVideo[] {
  const cut = Date.parse(options.cutAt);
  if (!Number.isFinite(cut)) throw new Error("Invalid ranking cutoff");
  if (!Number.isInteger(schedule.topN) || schedule.topN < 1 || schedule.topN > 63) throw new Error("topN must be between 1 and 63");
  if (!Number.isFinite(schedule.windowHours) || schedule.windowHours <= 0) throw new Error("Invalid ranking window");
  const all = [...sightings, ...(options.fallback ?? [])];
  const promoted = new Set(all.filter((row) => row.isAd || /promoted/i.test(row.music?.title ?? "")
    || (row.source === "tiktok-creative-center" && options.organicVideoIds && !options.organicVideoIds.has(row.videoId)))
    .map((row) => row.videoId));
  const eligible = (row: Sighting): boolean => row.platform === schedule.platform
    && (!schedule.excludePromoted || !promoted.has(row.videoId));
  const within = (row: Sighting, hours: number): boolean => {
    const at = Date.parse(schedule.window === "posted" ? row.createdAt : row.observedAt);
    return at >= cut - hours * 3_600_000 && at <= cut;
  };
  const candidates = sightings.filter(eligible);
  const result = rankCandidates(candidates.filter((row) => within(row, schedule.windowHours)), schedule.ranking);
  const append = (rows: RankedVideo[], fallback: boolean): void => {
    const ids = new Set(result.map((row) => row.videoId));
    for (const row of rows) {
      if (result.length >= schedule.topN) break;
      if (ids.has(row.videoId)) continue;
      result.push({ ...row, fallback });
      ids.add(row.videoId);
    }
  };
  append(rankCandidates(candidates.filter((row) => within(row, Math.max(48, schedule.windowHours))), schedule.ranking), false);
  append(rankCandidates((options.fallback ?? []).filter((row) => eligible(row)
    && Date.parse(row.observedAt) <= cut && Date.parse(row.createdAt) <= cut), schedule.ranking), true);
  return result.slice(0, schedule.topN).map((row, index) => ({ ...row, rank: index + 1 }));
}
