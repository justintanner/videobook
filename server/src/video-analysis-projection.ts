import type { ArtifactKind, Engine } from "videobook-engine";

/** Vision analysis sidecar written by the analyze_video job. */
export const VIDEO_ANALYSIS_FILE = ".original.analysis.json";

/** Artifact kinds the analyze_video job can describe from sampled frames. */
export function isAnalyzableVideo(kind: ArtifactKind): boolean {
  return kind === "video" || kind === "final";
}

/** Compact vision analysis shipped inside asset payloads. */
export type VideoAnalysisSummary = {
  summary: string;
  mood: string | null;
  setting: string | null;
  tags: string[];
  subjects: string[];
  scene_count: number;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

export function videoAnalysisSummaryFrom(raw: unknown): VideoAnalysisSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const analysis = raw as Record<string, unknown>;
  const summary = stringOrNull(analysis.summary);
  const tags = stringList(analysis.tags);
  const subjects = stringList(analysis.subjects);
  const sceneCount = Array.isArray(analysis.scenes) ? analysis.scenes.length : 0;
  if (!summary && tags.length === 0 && subjects.length === 0 && sceneCount === 0) {
    return null;
  }
  return {
    summary: summary ?? "",
    mood: stringOrNull(analysis.mood),
    setting: stringOrNull(analysis.setting),
    tags,
    subjects,
    scene_count: sceneCount,
  };
}

/** Vision analysis projection for an artifact, or null when it has not been analyzed. */
export async function readVideoAnalysisSummary(
  engine: Engine,
  assetId: string,
): Promise<VideoAnalysisSummary | null> {
  const read = await engine.files.read(assetId, VIDEO_ANALYSIS_FILE);
  if (!read.ok) return null;
  try {
    return videoAnalysisSummaryFrom(JSON.parse(read.value.toString()) as unknown);
  } catch {
    return null;
  }
}
