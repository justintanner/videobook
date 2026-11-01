export type SceneMarker = { t: number; score: number };

export type SceneFilmstripInfo = {
  url: string;
  frames: number;
  frameWidth: number;
  frameHeight: number;
  interval: number;
};

export type SceneData = {
  assetId: string;
  durationSeconds: number;
  fps: number;
  cuts: SceneMarker[];
  settles: SceneMarker[];
  filmstrip: SceneFilmstripInfo | null;
};

export type SceneCutOptions = {
  minScore?: number;
  includeSettles?: boolean;
  minSceneSeconds?: number;
};

export const DEFAULT_SCENE_MIN_SCORE = 5;
export const DEFAULT_MIN_SCENE_SECONDS = 0.5;

type RankedMarker = SceneMarker & { priority: number };

function candidateMarkers(scenes: SceneData, minScore: number, includeSettles: boolean): RankedMarker[] {
  const cuts = scenes.cuts
    .filter((cut) => cut.score >= minScore)
    .map((cut) => ({ ...cut, priority: 1 }));
  const settles = includeSettles ? scenes.settles.map((settle) => ({ ...settle, priority: 0 })) : [];
  return [...cuts, ...settles];
}

function fitsBetween(accepted: number[], t: number, duration: number, gap: number): boolean {
  if (t < gap || duration - t < gap) return false;
  return accepted.every((existing) => Math.abs(existing - t) >= gap);
}

export function selectSceneCuts(scenes: SceneData, options: SceneCutOptions = {}): number[] {
  const minScore = options.minScore ?? DEFAULT_SCENE_MIN_SCORE;
  const gap = Math.max(0.02, options.minSceneSeconds ?? DEFAULT_MIN_SCENE_SECONDS);
  const ranked = candidateMarkers(scenes, minScore, options.includeSettles ?? false)
    .sort((left, right) => right.priority - left.priority || right.score - left.score);
  const accepted: number[] = [];
  for (const marker of ranked) {
    if (fitsBetween(accepted, marker.t, scenes.durationSeconds, gap)) accepted.push(marker.t);
  }
  return accepted.sort((left, right) => left - right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMarkers(value: unknown): SceneMarker[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const t = Number(entry.t);
    const score = Number(entry.score);
    return Number.isFinite(t) && Number.isFinite(score) ? [{ t, score }] : [];
  });
}

function parseFilmstrip(value: unknown, fileUrl: (file: string) => string): SceneFilmstripInfo | null {
  if (!isRecord(value) || typeof value.file !== "string") return null;
  const frames = Number(value.frames);
  const frameWidth = Number(value.frameWidth);
  const frameHeight = Number(value.frameHeight);
  const interval = Number(value.interval);
  if (![frames, frameWidth, frameHeight, interval].every((n) => Number.isFinite(n) && n > 0)) return null;
  return { url: fileUrl(value.file), frames, frameWidth, frameHeight, interval };
}

export function parseSceneDocument(
  document: unknown,
  fileUrl: (file: string) => string,
): SceneData | null {
  if (!isRecord(document) || !Array.isArray(document.cuts)) return null;
  const durationSeconds = Number(document.duration);
  const fps = Number(document.fps);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return {
    assetId: String(document.asset_id ?? ""),
    durationSeconds,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    cuts: parseMarkers(document.cuts),
    settles: parseMarkers(document.settle_points),
    filmstrip: parseFilmstrip(document.filmstrip, fileUrl),
  };
}

export function asSceneData(value: unknown): SceneData | null {
  if (!isRecord(value) || !Array.isArray(value.cuts) || !Array.isArray(value.settles)) return null;
  const durationSeconds = Number(value.durationSeconds);
  const fps = Number(value.fps);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const filmstrip = isRecord(value.filmstrip) && typeof value.filmstrip.url === "string"
    ? parseFilmstrip({ ...value.filmstrip, file: value.filmstrip.url }, (file) => file)
    : null;
  return {
    assetId: String(value.assetId ?? ""),
    durationSeconds,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    cuts: parseMarkers(value.cuts),
    settles: parseMarkers(value.settles),
    filmstrip,
  };
}
