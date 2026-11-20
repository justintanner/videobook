import type { Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { runAnalysisComponentJob } from "../analysis-components.js";
import {
  analyzeAutoEditClip,
  AUTO_EDIT_MOMENTS,
  autoEditMomentAnalysisSchema,
  autoEditMomentsKey,
  autoEditTranscriptHashes,
} from "../auto-edit/analysis.js";
import { readAutoEditSource, writeAutoEditAnalyzedDraft } from "../auto-edit/drafts.js";
import { registerJobHandler } from "../queue.js";

interface AnalyzeAutoEditPayload {
  bookId: string;
  sourceArtifactId: string;
  componentKey: string;
  force?: boolean;
}

async function currentAutoEditKey(engine: Engine, artifactId: string): Promise<string | null> {
  try {
    const source = await readAutoEditSource(engine, artifactId);
    const transcripts = await autoEditTranscriptHashes(engine, artifactId);
    return autoEditMomentsKey(source.sourceHash, transcripts);
  } catch {
    return null;
  }
}

async function runAnalyzeAutoEdit(
  engine: Engine,
  payload: AnalyzeAutoEditPayload,
  signal: AbortSignal,
) {
  let currentSourceHash = "";
  const stored = await runAnalysisComponentJob({
    engine,
    spec: AUTO_EDIT_MOMENTS,
    key: payload.componentKey,
    artifactId: payload.sourceArtifactId,
    force: payload.force === true,
    schema: autoEditMomentAnalysisSchema,
    currentKey: () => currentAutoEditKey(engine, payload.sourceArtifactId),
    compute: async () => {
      const apiKey = requireApiKey("OPENAI_API_KEY");
      const source = await readAutoEditSource(engine, payload.sourceArtifactId);
      const transcripts = await autoEditTranscriptHashes(engine, payload.sourceArtifactId);
      if (autoEditMomentsKey(source.sourceHash, transcripts) !== payload.componentKey) {
        throw new Error("The source changed before analysis started. Try finding the moment again.");
      }
      currentSourceHash = source.sourceHash;
      const value = await analyzeAutoEditClip({
        engine,
        source: {
          artifactId: source.artifactId,
          sourceHash: source.sourceHash,
          fps: source.fps,
          frames: source.frames,
          width: source.width,
          height: source.height,
          hasAudio: source.hasAudio,
          durationSeconds: source.durationSeconds,
          path: source.path,
        },
        apiKey,
        signal,
      });
      return {
        value,
        sourceHash: source.sourceHash,
        provenance: {
          analyzer: AUTO_EDIT_MOMENTS.component,
          provider: "openai",
          model: value.model,
        },
      };
    },
  });
  const sourceHash = currentSourceHash || stored.sourceHash;
  writeAutoEditAnalyzedDraft(engine, payload.sourceArtifactId, sourceHash, stored.value.anchors, stored.value.changes);
  return {
    componentKey: stored.key,
    anchors: stored.value.anchors,
    summary: stored.value.summary,
    confidence: stored.value.confidence,
    changes: stored.value.changes,
  };
}

export function registerAnalyzeAutoEditJob(engine: Engine): void {
  registerJobHandler(AUTO_EDIT_MOMENTS.jobType, (payload, ctx) =>
    runAnalyzeAutoEdit(engine, payload as unknown as AnalyzeAutoEditPayload, ctx.signal),
  );
}
