import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { analysisComponentKey } from "./analysis-components.js";
import type { SidecarAnalysisSpec, SidecarInput } from "./analysis-sidecars.js";
import { readArtifactJson } from "./analysis-sidecars.js";
import { isFallbackAnalysis } from "./asset-tag-extraction.js";
import { INTELLIGENCE_MODEL } from "./openai-intelligence.js";
import { PLAIN_TRANSCRIPT_FILE, TIMED_TRANSCRIPT_FILE } from "./transcript-projection.js";
import { VIDEO_ANALYSIS_FILE } from "./video-analysis-projection.js";

export const VIDEO_ANALYSIS: SidecarAnalysisSpec = { component: "video-analysis", version: 1, jobType: "analyze_video", sidecar: VIDEO_ANALYSIS_FILE };

export const IMAGE_DESCRIPTION: SidecarAnalysisSpec = { component: "image-description", version: 1, jobType: "describe_image", sidecar: ".original.analysis.json" };

export const SCENE_DETECTION: SidecarAnalysisSpec = { component: "scene-detection", version: 1, jobType: "detect_scenes", sidecar: ".detect-scenes.json" };

export interface VideoAnalysisInputs {
  videoHash: string;
  transcript: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function videoAnalysisInputs(engine: Engine, artifactId: string, withTranscript: boolean): Promise<VideoAnalysisInputs | null> {
  const manifest = await engine.files.manifest(artifactId, { includeDotfiles: true });
  if (!manifest.ok) return null;
  const video = findVideoFile(manifest.value.files);
  if (!video) return null;
  const hashOf = (name: string) => manifest.value.files.find((file) => file.name === name)?.objectHash ?? null;
  const timed = hashOf(TIMED_TRANSCRIPT_FILE);
  const plain = hashOf(PLAIN_TRANSCRIPT_FILE);
  const transcript = !withTranscript ? null : timed ? `timed:${timed}` : plain ? `plain:${plain}` : null;
  return { videoHash: video.objectHash, transcript };
}

export function sameVideoAnalysisInputs(left: VideoAnalysisInputs | null, right: VideoAnalysisInputs | null): boolean {
  return left?.videoHash === right?.videoHash && left?.transcript === right?.transcript;
}

export async function hasRealVideoAnalysis(engine: Engine, artifactId: string): Promise<boolean> {
  const document = await readArtifactJson(engine, artifactId, VIDEO_ANALYSIS_FILE);
  return isRecord(document) && !isFallbackAnalysis(document);
}

export function videoAnalysisRecord(engine: Engine, artifactId: string, inputs: VideoAnalysisInputs): SidecarInput {
  return {
    artifactId,
    key: analysisComponentKey(VIDEO_ANALYSIS, {
      sourceHash: inputs.videoHash,
      dependencies: inputs.transcript ? [inputs.transcript] : [],
      options: { model: INTELLIGENCE_MODEL },
    }),
    sourceHash: inputs.videoHash,
    adoptLegacy: () => hasRealVideoAnalysis(engine, artifactId),
  };
}

export function imageDescriptionRecord(engine: Engine, artifactId: string, imageHash: string): SidecarInput {
  return {
    artifactId,
    key: analysisComponentKey(IMAGE_DESCRIPTION, { sourceHash: imageHash, options: { model: INTELLIGENCE_MODEL } }),
    sourceHash: imageHash,
    adoptLegacy: async () => {
      const document = await readArtifactJson(engine, artifactId, IMAGE_DESCRIPTION.sidecar);
      return isRecord(document) && typeof document.prompt === "string" && document.prompt.trim().length > 0;
    },
  };
}

export function sceneDetectionRecord(artifactId: string, videoHash: string): SidecarInput {
  return { artifactId, key: analysisComponentKey(SCENE_DETECTION, { sourceHash: videoHash }), sourceHash: videoHash };
}
