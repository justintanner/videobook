import type { Engine } from "videobook-engine";
import { readAssetTranscript } from "./transcript-projection.js";
import { VIDEO_ANALYSIS_FILE } from "./video-analysis-projection.js";

const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_SCENES = 12;

export type ClipAnalysis = {
  summary: string;
  mood: string;
  setting: string;
  subjects: string[];
  actions: string[];
  tags: string[];
  scenes: string[];
  textOnScreen: string[];
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function sceneLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SCENES).map((scene) => {
    const record = scene && typeof scene === "object" ? scene as Record<string, unknown> : {};
    const at = typeof record.timestamp === "number" ? `${record.timestamp.toFixed(1)}s: ` : "";
    const description = text(record.description);
    return description ? `${at}${description}` : "";
  }).filter(Boolean);
}

function clipAnalysisFrom(raw: unknown): ClipAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const analysis: ClipAnalysis = {
    summary: text(record.summary),
    mood: text(record.mood),
    setting: text(record.setting),
    subjects: texts(record.subjects),
    actions: texts(record.actions),
    tags: texts(record.tags),
    scenes: sceneLines(record.scenes),
    textOnScreen: texts(record.textOnScreen),
  };
  const empty = !analysis.summary && analysis.scenes.length === 0 && analysis.tags.length === 0 && analysis.subjects.length === 0;
  return empty ? null : analysis;
}

export async function readClipAnalysis(engine: Engine, assetId: string): Promise<ClipAnalysis | null> {
  const read = await engine.files.read(assetId, VIDEO_ANALYSIS_FILE);
  if (!read.ok) return null;
  try {
    return clipAnalysisFrom(JSON.parse(read.value.toString()) as unknown);
  } catch {
    return null;
  }
}

export async function readClipTranscript(engine: Engine, assetIds: readonly string[]): Promise<string | null> {
  for (const assetId of assetIds) {
    const transcript = await readAssetTranscript(engine, assetId);
    if (transcript.kind === "timed" || transcript.kind === "plain") {
      const value = transcript.text.trim();
      if (value) return value.slice(0, MAX_TRANSCRIPT_CHARS);
    }
  }
  return null;
}

function listLine(name: string, values: readonly string[]): string | null {
  return values.length ? `${name}: ${values.join(", ")}` : null;
}

export function clipAnalysisLines(analysis: ClipAnalysis): string[] {
  return [
    analysis.summary ? `Summary: ${analysis.summary}` : null,
    analysis.mood ? `Mood: ${analysis.mood}` : null,
    analysis.setting ? `Setting: ${analysis.setting}` : null,
    listLine("Subjects", analysis.subjects),
    listLine("Actions", analysis.actions),
    listLine("Analysis tags", analysis.tags),
    listLine("Text on screen", analysis.textOnScreen),
    analysis.scenes.length ? `Scenes:\n${analysis.scenes.map((scene) => `- ${scene}`).join("\n")}` : null,
  ].filter((line): line is string => line !== null);
}
