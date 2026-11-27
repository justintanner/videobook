import type { Sighting, TrendingCriteria, TrendingSchedule } from "./types.js";

export interface TrendingCandidate extends Sighting {
  sources: string[];
}

export interface CollectCandidatesOptions {
  cutAt: string;
  exclude?: ReadonlySet<string>;
}

export type ScreenReason =
  | "promoted"
  | "paid-reach"
  | "photo"
  | "ai"
  | "duration"
  | "stale"
  | "small"
  | "elsewhere";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const CREATIVE_CENTER_SOURCE = "tiktok-creative-center";
const PROMOTED_MUSIC_PATTERN = /promoted/i;
const ISO_REGION_CODE_PATTERN = /^[a-z]{2}$/i;

const DEFAULT_CRITERIA = {
  minViews: 100_000,
  maxAgeDays: 30,
  maxDurationSeconds: 60,
  judgeLimit: 120,
} as const;

const SCREEN_CONSTANTS = {
  minWindowHours: 48,
  minLikeRate: 0.005,
  minDurationSeconds: 4,
} as const;

const ORGANIC_SCORE_CONSTANTS = {
  earnedFloor: 0.005,
  earnedSpan: 0.025,
  shareWeight: 0.6,
  shareCap: 0.02,
  saveWeight: 0.25,
  saveCap: 0.004,
  commentWeight: 0.15,
  commentCap: 0.0005,
  ageFloorDays: 0.5,
  paceFloorViewsPerDay: 10_000,
  paceLogSpan: 2,
  paceWeight: 0.5,
  buzzWeight: 0.5,
} as const;

const regionDisplayNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "code" });

function sat(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function parseCutAt(cutAt: string): number {
  const cut = Date.parse(cutAt);
  if (!Number.isFinite(cut)) throw new Error("Invalid ranking cutoff");
  return cut;
}

function firstDefined<T, R>(items: readonly T[], pick: (item: T) => R | undefined): R | undefined {
  for (const item of items) {
    const value = pick(item);
    if (value !== undefined) return value;
  }
  return undefined;
}

function countryName(country: string): string {
  const normalized = country.trim().toUpperCase();
  if (ISO_REGION_CODE_PATTERN.test(normalized)) {
    try {
      return regionDisplayNames.of(normalized) ?? normalized;
    } catch {
      return normalized;
    }
  }
  return country.trim() || normalized;
}

export function defaultBrief(country: string): string {
  const name = countryName(country);
  return `Real footage of ordinary people, animals or everyday scenes in ${name} where something funny, odd, surprising or heart-warming happens: street and market moments, workers, vehicles, weather and floods, festivals, pets and wildlife. Filmed on a phone, ideally one continuous shot with a clear subject. Not wanted: ads, brand or shop accounts, sponsored posts, celebrities, news reports, TV or drama clips, scripted skits, dance or lip-sync, fan edits, compilations, animation, games, AI-generated video, product demos, or clips filmed outside ${name}.`;
}

export function resolveCriteria(schedule: TrendingSchedule): TrendingCriteria & { brief: string } {
  const custom = schedule.criteria;
  const brief = custom?.brief && custom.brief.trim().length > 0
    ? custom.brief
    : defaultBrief(schedule.country);
  return {
    brief,
    minViews: custom?.minViews ?? DEFAULT_CRITERIA.minViews,
    maxAgeDays: custom?.maxAgeDays ?? DEFAULT_CRITERIA.maxAgeDays,
    maxDurationSeconds: custom?.maxDurationSeconds ?? DEFAULT_CRITERIA.maxDurationSeconds,
    judgeLimit: custom?.judgeLimit ?? DEFAULT_CRITERIA.judgeLimit,
  };
}

function compareLatestFirst(left: Sighting, right: Sighting): number {
  const rightTime = Date.parse(right.observedAt);
  const leftTime = Date.parse(left.observedAt);
  const timeDiff = (Number.isFinite(rightTime) ? rightTime : -Infinity)
    - (Number.isFinite(leftTime) ? leftTime : -Infinity);
  return timeDiff || right.metrics.views - left.metrics.views;
}

function mergeSightings(group: readonly Sighting[]): TrendingCandidate {
  const ordered = [...group].sort(compareLatestFirst);
  const latest = ordered[0];
  const sources = [...new Set(ordered.map((row) => row.source))].sort();

  const followers = firstDefined(ordered, (row) => row.author.followers);
  const verified = firstDefined(ordered, (row) => row.author.verified);
  const durationSeconds = firstDefined(ordered, (row) => row.durationSeconds);
  const coverUrl = firstDefined(ordered, (row) => row.coverUrl);
  const kind = firstDefined(ordered, (row) => row.kind);
  const aiGenerated = firstDefined(ordered, (row) => row.aiGenerated);
  const language = firstDefined(ordered, (row) => row.language);
  const originRegion = firstDefined(ordered, (row) => row.originRegion);
  const feed = firstDefined(ordered, (row) => row.feed);

  const baseMusic = latest.music ?? firstDefined(ordered, (row) => row.music);
  const original = firstDefined(ordered, (row) => row.music?.original);
  const music = baseMusic
    ? { ...baseMusic, ...(original === undefined ? {} : { original }) }
    : undefined;

  const promotedInOther = ordered.some(
    (row) => row.isAd === true || (row !== latest && PROMOTED_MUSIC_PATTERN.test(row.music?.title ?? "")),
  );
  const isAd = promotedInOther ? true : latest.isAd;

  return {
    ...latest,
    author: {
      ...latest.author,
      ...(followers === undefined ? {} : { followers }),
      ...(verified === undefined ? {} : { verified }),
    },
    metrics: { ...latest.metrics },
    ...(language === undefined ? {} : { language }),
    ...(originRegion === undefined ? {} : { originRegion }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(coverUrl === undefined ? {} : { coverUrl }),
    ...(kind === undefined ? {} : { kind }),
    ...(aiGenerated === undefined ? {} : { aiGenerated }),
    ...(feed === undefined ? {} : { feed }),
    ...(music === undefined ? {} : { music }),
    ...(isAd === undefined ? {} : { isAd }),
    sources,
  };
}

export function collectCandidates(
  sightings: readonly Sighting[],
  schedule: TrendingSchedule,
  options: CollectCandidatesOptions,
): TrendingCandidate[] {
  const cut = parseCutAt(options.cutAt);
  if (!Number.isFinite(schedule.windowHours) || schedule.windowHours <= 0) {
    throw new Error("Invalid ranking window");
  }
  const windowStart = cut - Math.max(SCREEN_CONSTANTS.minWindowHours, schedule.windowHours) * MS_PER_HOUR;
  const groups = new Map<string, Sighting[]>();

  for (const row of sightings) {
    if (row.fallback) continue;
    if (row.source === CREATIVE_CENTER_SOURCE) continue;
    if (row.platform !== schedule.platform) continue;
    if (options.exclude?.has(row.videoId)) continue;
    const timestamp = Date.parse(schedule.window === "posted" ? row.createdAt : row.observedAt);
    if (!Number.isFinite(timestamp) || timestamp < windowStart || timestamp > cut) continue;
    const existing = groups.get(row.videoId);
    if (existing) existing.push(row);
    else groups.set(row.videoId, [row]);
  }

  return [...groups.values()].map(mergeSightings);
}

export function screenCandidate(
  candidate: TrendingCandidate,
  schedule: TrendingSchedule,
  criteria: TrendingCriteria,
  cutAt: string,
): ScreenReason | undefined {
  const cut = parseCutAt(cutAt);

  if (
    schedule.excludePromoted
    && (candidate.isAd === true || PROMOTED_MUSIC_PATTERN.test(candidate.music?.title ?? ""))
  ) {
    return "promoted";
  }

  const { views, likes } = candidate.metrics;
  if (views <= 0 || likes / views < SCREEN_CONSTANTS.minLikeRate) {
    return "paid-reach";
  }

  if (candidate.kind === "photo" || candidate.durationSeconds === 0) {
    return "photo";
  }

  if (candidate.aiGenerated === true) {
    return "ai";
  }

  if (
    candidate.durationSeconds !== undefined
    && (candidate.durationSeconds < SCREEN_CONSTANTS.minDurationSeconds
      || candidate.durationSeconds > criteria.maxDurationSeconds)
  ) {
    return "duration";
  }

  const ageDays = (cut - Date.parse(candidate.createdAt)) / MS_PER_DAY;
  if (ageDays > criteria.maxAgeDays) {
    return "stale";
  }

  if (views < criteria.minViews) {
    return "small";
  }

  if (
    candidate.originRegion !== undefined
    && ISO_REGION_CODE_PATTERN.test(candidate.originRegion)
    && candidate.originRegion.toUpperCase() !== schedule.country.toUpperCase()
  ) {
    return "elsewhere";
  }

  return undefined;
}

export function organicScore(candidate: TrendingCandidate, cutAt: string): number {
  const cut = parseCutAt(cutAt);
  const { views, likes, shares, saves, comments } = candidate.metrics;
  if (!Number.isFinite(views) || views <= 0) return 0;

  const earned = sat((likes / views - ORGANIC_SCORE_CONSTANTS.earnedFloor) / ORGANIC_SCORE_CONSTANTS.earnedSpan);

  let buzzSum = 0;
  let buzzWeight = 0;
  if (shares !== undefined) {
    buzzSum += ORGANIC_SCORE_CONSTANTS.shareWeight * sat(shares / views / ORGANIC_SCORE_CONSTANTS.shareCap);
    buzzWeight += ORGANIC_SCORE_CONSTANTS.shareWeight;
  }
  if (saves !== undefined) {
    buzzSum += ORGANIC_SCORE_CONSTANTS.saveWeight * sat(saves / views / ORGANIC_SCORE_CONSTANTS.saveCap);
    buzzWeight += ORGANIC_SCORE_CONSTANTS.saveWeight;
  }
  if (comments !== undefined) {
    buzzSum += ORGANIC_SCORE_CONSTANTS.commentWeight * sat(comments / views / ORGANIC_SCORE_CONSTANTS.commentCap);
    buzzWeight += ORGANIC_SCORE_CONSTANTS.commentWeight;
  }
  const buzz = buzzWeight > 0 ? buzzSum / buzzWeight : 0;

  const ageDays = (cut - Date.parse(candidate.createdAt)) / MS_PER_DAY;
  const effectiveAgeDays = Number.isFinite(ageDays)
    ? Math.max(ageDays, ORGANIC_SCORE_CONSTANTS.ageFloorDays)
    : ORGANIC_SCORE_CONSTANTS.ageFloorDays;
  const viewsPerDay = views / effectiveAgeDays;
  const pace = sat(
    Math.log10(viewsPerDay / ORGANIC_SCORE_CONSTANTS.paceFloorViewsPerDay)
      / ORGANIC_SCORE_CONSTANTS.paceLogSpan,
  );

  return earned * (ORGANIC_SCORE_CONSTANTS.paceWeight * pace + ORGANIC_SCORE_CONSTANTS.buzzWeight * buzz);
}
