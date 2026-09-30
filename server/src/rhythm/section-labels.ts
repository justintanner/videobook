import type { Engine } from "videobook-engine";
import type { OpenAiResponseInputContent } from "@apicity/openai";
import {
  INTELLIGENCE_MODEL,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";
import { getApiKey } from "../api-key.js";
import { assessToolCallEstimate, logUnavailableCostEstimate } from "../jobs/cost-estimate-assessment.js";
import { energySegments } from "./energy.js";
import {
  sectionLabelsSchema,
  type MusicAnalysis,
  type SectionLabels,
} from "./model.js";
import { cachedMusicAnalysis, musicSource, readSectionLabels, sectionLabelsCurrent } from "./music-analysis.js";
import { SECTION_DETECTOR_ID, SECTION_DETECTOR_VERSION, SECTION_LABELER_ID, SECTION_LABELER_VERSION } from "./contract.js";

const LABEL_PROMPT = [
  "You label pre-detected section boundaries in a song for a video editor.",
  "Each candidate boundary was detected from the song's energy curve; its id, position and detection quality are given.",
  "Assign exactly one label per candidate id, choosing from: intro, verse, chorus, drop, break, bridge, outro.",
  "You cannot move, add, or remove boundaries: label only the listed candidate ids.",
  "Labels are editorial suggestions, not facts. Judge from the energy arc around each boundary, not from lyrics you imagine.",
  'Answer with JSON {"labels": [{candidate_id, label, confidence, rationale}]} covering every candidate id exactly once.',
  "confidence is 0-1. rationale is one short sentence grounded in the reported energy data.",
].join(" ");

const LABELS_JSON_SCHEMA = {
  type: "object",
  required: ["labels"],
  additionalProperties: false,
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        required: ["candidate_id", "label", "confidence", "rationale"],
        additionalProperties: false,
        properties: {
          candidate_id: { type: "string" },
          label: { type: "string", enum: ["intro", "verse", "chorus", "drop", "break", "bridge", "outro"] },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
      },
    },
  },
} as const;

export async function labelMusicSections(
  engine: Engine,
  artifactId: string,
  analysisId: string,
  streamId: string,
  signal: AbortSignal,
): Promise<SectionLabels> {
  const source = await musicSource(engine, artifactId, streamId);
  if (source.analysisId !== analysisId) throw new Error("The audio source changed; analyze it again");
  const analysis = await cachedMusicAnalysis(engine, source);
  if (!analysis || analysis.analysisId !== analysisId) throw new Error("Run analyze_music before requesting section labels");
  if (!analysis.energy || !analysis.sections) throw new Error("The analysis has no energy curve; analyze the current audio again");
  const stored = await readSectionLabels(engine, artifactId, analysisId);
  if (stored && stored.status === "ready" && sectionLabelsCurrent(stored, analysis)) return stored;
  const next = await buildLabels(engine, analysis, signal);
  const saved = await engine.metadata.artifacts.write(artifactId, `music.sections.${analysisId}`, next);
  if (!saved.ok) throw new Error(saved.error.message);
  return next;
}

async function buildLabels(engine: Engine, analysis: MusicAnalysis, signal: AbortSignal): Promise<SectionLabels> {
  const header = {
    schemaVersion: 1 as const,
    analysisId: analysis.analysisId,
    artifactId: analysis.artifactId,
    objectHash: analysis.objectHash,
    streamId: analysis.streamId,
    labeler: { id: SECTION_LABELER_ID, version: SECTION_LABELER_VERSION, model: "" },
    boundaries: {
      algorithmId: analysis.sections?.algorithmId ?? SECTION_DETECTOR_ID,
      algorithmVersion: analysis.sections?.algorithmVersion ?? SECTION_DETECTOR_VERSION,
    },
    createdAt: Date.now(),
  };
  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey) {
    return sectionLabelsSchema.parse({
      ...header,
      status: "unavailable",
      reason: "OPENAI_API_KEY is not set; section labels stay optional",
      labels: [],
    });
  }
  signal.throwIfAborted();
  await adviseCostEstimate(engine, analysis);
  const response = await requestLabels(apiKey, analysis, signal);
  return sectionLabelsSchema.parse({
    ...header,
    labeler: { id: SECTION_LABELER_ID, version: SECTION_LABELER_VERSION, model: INTELLIGENCE_MODEL },
    status: "ready",
    reason: null,
    labels: response,
  });
}

async function requestLabels(apiKey: string, analysis: MusicAnalysis, signal: AbortSignal) {
  if (!analysis.energy || !analysis.sections) throw new Error("The analysis has no energy curve");
  const segments = energySegments(analysis.energy, analysis.sections, analysis.durationSeconds);
  const tierFor = (timeSeconds: number) => segments.find((segment) => timeSeconds >= segment.startSeconds && timeSeconds < segment.endSeconds);
  const lines = analysis.sections.candidates.map((candidate) => {
    const segment = tierFor(candidate.timeSeconds);
    const mean = segment ? `segment ${segment.startSeconds.toFixed(1)}-${segment.endSeconds.toFixed(1)}s energy ${segment.tier} (mean ${segment.meanEnergy.toFixed(2)})` : "segment energy unknown";
    return `${candidate.id}: ${candidate.timeSeconds.toFixed(1)}s, detection quality ${candidate.quality.toFixed(2)}, ${mean}`;
  });
  const content: OpenAiResponseInputContent[] = [{
    type: "input_text",
    text: [
      `Song duration ${analysis.durationSeconds.toFixed(1)}s${analysis.bpm ? `, tempo about ${analysis.bpm.toFixed(0)} BPM` : ""}.`,
      `Detected section boundary candidates:`,
      ...lines,
    ].join("\n"),
  }];
  const responses = buildIntelligenceResponses(apiKey, { timeout: 120_000 });
  const response = await responses(intelligenceRequest({
    instructions: LABEL_PROMPT,
    input: [{ role: "user", content }],
    text: { format: { type: "json_schema", name: "section_labels", schema: LABELS_JSON_SCHEMA, strict: true } },
    max_output_tokens: 2048,
  }), signal);
  const wanted = new Map(analysis.sections.candidates.map((candidate, index) => [candidate.id, index]));
  const seen = new Set<string>();
  const labels: SectionLabels["labels"] = [];
  for (const entry of parseLabelResponse(firstResponseText(response))) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.candidate_id === "string" ? row.candidate_id : "";
    const label = row.label;
    if (!wanted.has(id) || seen.has(id)) continue;
    if (typeof label !== "string" || !["intro", "verse", "chorus", "drop", "break", "bridge", "outro"].includes(label)) continue;
    seen.add(id);
    labels.push({
      candidateId: id,
      label: label as SectionLabels["labels"][number]["label"],
      confidence: Math.min(1, Math.max(0, typeof row.confidence === "number" && Number.isFinite(row.confidence) ? row.confidence : 0)),
      rationale: typeof row.rationale === "string" ? row.rationale.slice(0, 500) : "",
    });
  }
  if (labels.length !== wanted.size) throw new Error("The section labeler did not cover every boundary; retry labeling");
  return labels;
}

function parseLabelResponse(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return [];
  const labels = (parsed as Record<string, unknown>).labels;
  return Array.isArray(labels) ? labels : [];
}

async function adviseCostEstimate(engine: Engine, analysis: MusicAnalysis): Promise<void> {
  try {
    const assessment = await assessToolCallEstimate(engine, "analyze_video", { asset_id: analysis.artifactId });
    if (!assessment.available) {
      await logUnavailableCostEstimate({
        assessment,
        engine,
        correlation: {
          bookId: engine.book.get().bookId,
          artifactId: analysis.artifactId,
          tool: "label_music_sections",
          provider: "openai",
          model: INTELLIGENCE_MODEL,
          stage: "label-music-sections",
        },
      });
    }
  } catch {
    return;
  }
}
