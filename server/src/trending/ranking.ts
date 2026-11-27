import {
  collectCandidates,
  organicScore,
  resolveCriteria,
  screenCandidate,
  type CollectCandidatesOptions,
  type TrendingCandidate,
} from "./authenticity.js";
import type {
  RankedVideo,
  Sighting,
  TrendingFunnel,
  TrendingSchedule,
  TrendingVerdict,
} from "./types.js";

const AUTHENTIC_RANK_CONSTANTS = {
  minFit: 6,
  fitScale: 10,
  fitBaseWeight: 0.6,
  fitOrganicWeight: 0.4,
} as const;

export interface RankingOptions {
  cutAt: string;
  fallback?: readonly Sighting[];
  organicVideoIds?: ReadonlySet<string>;
  exclude?: ReadonlySet<string>;
  verdicts?: ReadonlyMap<string, TrendingVerdict>;
  checked?: number;
}

export interface ScoredCandidate extends TrendingCandidate {
  organic: number;
}

export interface AuthenticCandidatesResult {
  seen: number;
  screened: Record<string, number>;
  candidates: ScoredCandidate[];
}

export interface AuthenticRankingResult {
  videos: RankedVideo[];
  funnel: TrendingFunnel;
}

function validateScheduleBounds(schedule: Pick<TrendingSchedule, "topN" | "windowHours" | "ranking">): void {
  if (!Number.isInteger(schedule.topN) || schedule.topN < 1 || schedule.topN > 63) {
    throw new Error("topN must be between 1 and 63");
  }
  if (!Number.isFinite(schedule.windowHours) || schedule.windowHours <= 0) {
    throw new Error("Invalid ranking window");
  }
  if (schedule.ranking !== "views" && schedule.ranking !== "consensus" && schedule.ranking !== "authentic") {
    throw new Error(`Unsupported ranking method: ${String(schedule.ranking)}`);
  }
}

export function validateRanking(schedule: TrendingSchedule, cutAt: string): number {
  const cut = Date.parse(cutAt);
  if (!Number.isFinite(cut)) throw new Error("Invalid ranking cutoff");
  validateScheduleBounds(schedule);
  return cut;
}

function compareViews(left: RankedVideo, right: RankedVideo): number {
  return right.metrics.views - left.metrics.views
    || right.sources.length - left.sources.length
    || right.metrics.likes - left.metrics.likes
    || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.videoId.localeCompare(right.videoId);
}

function compareOrganic(left: ScoredCandidate, right: ScoredCandidate): number {
  return right.organic - left.organic
    || right.metrics.views - left.metrics.views
    || left.videoId.localeCompare(right.videoId);
}

function rankCandidates(sightings: readonly Sighting[], method: "views" | "consensus"): RankedVideo[] {
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
  return [...byId.values()].sort((left, right) => {
    if (method === "views") return compareViews(left, right);
    return (points.get(right.videoId) ?? 0) - (points.get(left.videoId) ?? 0)
      || right.metrics.views - left.metrics.views
      || compareViews(left, right);
  });
}

function rankLegacyVideos(
  sightings: readonly Sighting[],
  schedule: TrendingSchedule,
  options: RankingOptions,
  cut: number,
  method: "views" | "consensus",
): RankedVideo[] {
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
  const candidates = sightings.filter((row) => !row.fallback && eligible(row));
  const rankWindow = (hours: number): RankedVideo[] => {
    const rows = candidates.filter((row) => within(row, hours));
    const ids = new Set(rows.map((row) => row.videoId));
    const crossChecks = sightings.filter((row) => row.fallback && ids.has(row.videoId)
      && eligible(row) && Date.parse(row.observedAt) <= cut);
    return rankCandidates([...rows, ...crossChecks], method);
  };
  const result = rankWindow(schedule.windowHours);
  const append = (rows: RankedVideo[], fallback: boolean): void => {
    const ids = new Set(result.map((row) => row.videoId));
    for (const row of rows) {
      if (result.length >= schedule.topN) break;
      if (ids.has(row.videoId)) continue;
      result.push({ ...row, fallback });
      ids.add(row.videoId);
    }
  };
  append(rankWindow(Math.max(48, schedule.windowHours)), false);
  append(rankCandidates((options.fallback ?? []).filter((row) => eligible(row)
    && Date.parse(row.observedAt) <= cut && Date.parse(row.createdAt) <= cut), method), true);
  return result.slice(0, schedule.topN).map((row, index) => ({ ...row, rank: index + 1 }));
}

export function prepareAuthenticCandidates(
  sightings: readonly Sighting[],
  schedule: TrendingSchedule,
  options: CollectCandidatesOptions,
): AuthenticCandidatesResult {
  validateRanking(schedule, options.cutAt);
  const collected = collectCandidates(sightings, schedule, options);
  const criteria = resolveCriteria(schedule);
  const screened: Record<string, number> = {};
  const candidates: ScoredCandidate[] = [];
  for (const candidate of collected) {
    const reason = screenCandidate(candidate, schedule, criteria, options.cutAt);
    if (reason) {
      screened[reason] = (screened[reason] ?? 0) + 1;
      continue;
    }
    candidates.push({ ...candidate, organic: organicScore(candidate, options.cutAt) });
  }
  candidates.sort(compareOrganic);
  return { seen: collected.length, screened, candidates };
}

export function rankAuthentic(
  candidates: readonly ScoredCandidate[],
  schedule: Pick<TrendingSchedule, "topN" | "windowHours" | "ranking">,
  verdicts: ReadonlyMap<string, TrendingVerdict> = new Map(),
  funnelInput: { seen?: number; screened?: Record<string, number>; checked?: number } = {},
): AuthenticRankingResult {
  validateScheduleBounds(schedule);
  const hasVerdicts = candidates.some((candidate) => verdicts.has(candidate.videoId));
  let fitCount = 0;
  const qualified: { candidate: ScoredCandidate; score: number; verdict?: TrendingVerdict }[] = [];
  for (const candidate of candidates) {
    const verdict = verdicts.get(candidate.videoId);
    if (verdict && verdict.fit >= AUTHENTIC_RANK_CONSTANTS.minFit) fitCount += 1;
    if (hasVerdicts) {
      if (!verdict || verdict.fit < AUTHENTIC_RANK_CONSTANTS.minFit) continue;
      const score = (verdict.fit / AUTHENTIC_RANK_CONSTANTS.fitScale)
        * (AUTHENTIC_RANK_CONSTANTS.fitBaseWeight + AUTHENTIC_RANK_CONSTANTS.fitOrganicWeight * candidate.organic);
      qualified.push({ candidate, score, verdict });
    } else {
      qualified.push({ candidate, score: candidate.organic });
    }
  }
  qualified.sort((left, right) => right.score - left.score
    || right.candidate.organic - left.candidate.organic
    || right.candidate.metrics.views - left.candidate.metrics.views
    || left.candidate.videoId.localeCompare(right.candidate.videoId));
  const videos: RankedVideo[] = qualified.slice(0, schedule.topN).map(({ candidate, score, verdict }, index) => {
    const { coverUrl: _coverUrl, organic, ...rest } = candidate;
    return {
      ...rest,
      rank: index + 1,
      fallback: false,
      authentic: {
        score,
        organic,
        ...(verdict ? { verdict: { ...verdict } } : {}),
      },
    };
  });
  const funnel: TrendingFunnel = {
    seen: funnelInput.seen ?? candidates.length,
    screened: { ...(funnelInput.screened ?? {}) },
    candidates: candidates.length,
    checked: funnelInput.checked ?? 0,
    fit: fitCount,
  };
  return { videos, funnel };
}

export function rankVideos(
  sightings: readonly Sighting[],
  schedule: TrendingSchedule,
  options: RankingOptions,
): RankedVideo[] {
  const cut = validateRanking(schedule, options.cutAt);
  switch (schedule.ranking) {
    case "authentic": {
      const prepared = prepareAuthenticCandidates(sightings, schedule, {
        cutAt: options.cutAt,
        exclude: options.exclude,
      });
      return rankAuthentic(prepared.candidates, schedule, options.verdicts, {
        seen: prepared.seen,
        screened: prepared.screened,
        checked: options.checked,
      }).videos;
    }
    case "views":
    case "consensus":
      return rankLegacyVideos(sightings, schedule, options, cut, schedule.ranking);
    default: {
      const unknown: never = schedule.ranking;
      throw new Error(`Unsupported ranking method: ${String(unknown)}`);
    }
  }
}
