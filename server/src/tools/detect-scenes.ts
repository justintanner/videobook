import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { z } from "zod";
import { readArtifactJson, requestSidecarAnalysis } from "../analysis-sidecars.js";
import type { SceneData } from "../scene-cuts.js";
import { parseSceneDocument } from "../scene-cuts.js";
import { SCENE_DETECTION, sceneDetectionRecord } from "../vision-components.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";

type SceneRequestResult =
  | { ok: true; assetId: string; jobId: number | null; status: string; scenes: SceneData | null; counts: Record<string, unknown> }
  | { ok: false; error: string };

function summary(document: unknown): Record<string, unknown> {
  if (typeof document !== "object" || document === null) return {};
  const { count, shots, settles } = document as Record<string, unknown>;
  return { count, shots, settles };
}

function errorResult(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function sceneFileUrl(bookId: string, assetId: string): (file: string) => string {
  return (file) => `/files/${bookId}/${assetId}/${file}`;
}

function resolveAssetId(engine: Engine, reference: string, notebookId?: string): string {
  const trimmed = reference.trim();
  if (engine.artifacts.get(trimmed.replace(/^@/, "")).ok) return trimmed.replace(/^@/, "");
  return resolveVideoAssetReference(engine, trimmed, notebookId);
}

export async function requestScenes(
  engine: Engine,
  input: { reference: string; bookId: string; notebookId?: string; force: boolean },
): Promise<SceneRequestResult> {
  let assetId: string;
  try {
    assetId = resolveAssetId(engine, input.reference, input.notebookId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const manifestResult = await engine.files.manifest(assetId);
  if (!manifestResult.ok) return { ok: false, error: manifestResult.error.message };
  const videoFile = findVideoFile(manifestResult.value.files);
  if (!videoFile) return { ok: false, error: `No video file found in asset ${assetId}` };

  const requested = await requestSidecarAnalysis(engine, SCENE_DETECTION, {
    ...sceneDetectionRecord(assetId, videoFile.objectHash),
    force: input.force,
    payload: { assetId, assetDir: manifestResult.value.path, bookId: input.bookId },
  });
  if (requested.status !== "cached") {
    return { ok: true, assetId, jobId: requested.jobId, status: requested.status, scenes: null, counts: {} };
  }
  const document = await readArtifactJson(engine, assetId, SCENE_DETECTION.sidecar);
  return {
    ok: true,
    assetId,
    jobId: requested.jobId,
    status: requested.status,
    scenes: parseSceneDocument(document, sceneFileUrl(input.bookId, assetId)),
    counts: summary(document),
  };
}

export function detectScenesDef(engine: Engine): ToolDef {
  return {
    name: "detect_scenes",
    description:
      "Find natural visual breaks in a video in a background job: camera cuts (frame-accurate) and motion-settle moments inside steady shots, each with a time and score. Read-only. Returns status cached with the counts when the current video was already scanned; detail full also returns every cut, settle and a filmstrip sprite URL.",
    schema: {
      source_asset_id: z.string().describe("Video asset id or notebook cell reference such as @a1"),
      book_id: z.string().describe("Book id"),
      notebook_id: z.string().uuid().optional().describe("Notebook UUID when source_asset_id is a grid reference and the book has multiple matching notebooks"),
      force: z.boolean().optional().default(false).describe("Scan again even when the current video was already scanned"),
      detail: z.enum(["summary", "full"]).optional().default("summary").describe("summary returns counts; full also returns cuts, settles, duration, fps and the filmstrip"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { source_asset_id, book_id, notebook_id, force, detail } = args as {
        source_asset_id: string;
        book_id: string;
        notebook_id?: string;
        force: boolean;
        detail: "summary" | "full";
      };
      const result = await requestScenes(engine, {
        reference: source_asset_id,
        bookId: book_id,
        notebookId: notebook_id,
        force,
      });
      if (!result.ok) return errorResult(result.error);
      const scenes = detail === "full" && result.scenes ? { scenes: result.scenes } : {};
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: result.assetId,
            job_id: result.jobId,
            status: result.status,
            ...result.counts,
            ...scenes,
          }),
        }],
      };
    },
  };
}
