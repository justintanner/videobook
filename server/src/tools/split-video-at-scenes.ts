import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { normalizeNotebookReference } from "videobook-engine/notebook-mentions";
import { join } from "node:path";
import { z } from "zod";
import { probeVideo } from "../ffmpeg.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { resolveNotebookArtifactReference } from "../notebook-reference-resolver.js";
import { enqueueNotebookRun } from "../notebook-run-enqueue.js";
import type { NotebookSplitDraft } from "../notebook-split-plan.js";
import { planNotebookSplit } from "../notebook-split-plan.js";
import { waitForBookJob } from "../queue.js";
import type { SceneCutOptions, SceneData } from "../scene-cuts.js";
import { DEFAULT_MIN_SCENE_SECONDS, DEFAULT_SCENE_MIN_SCORE, selectSceneCuts } from "../scene-cuts.js";
import { requestScenes } from "./detect-scenes.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const SCENE_WAIT_MS = 600_000;

type SplitSource = { document: NotebookDocument; cell: NotebookCell; artifactId: string };

type SplitArgs = {
  asset_id: string;
  book_id: string;
  notebook_id?: string;
  min_score?: number;
  include_settles?: boolean;
  min_scene_seconds?: number;
  cut_points_seconds?: number[];
  actor?: string;
};

function errorResult(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function notebookCandidates(engine: Engine, notebookId: string | undefined): NotebookDocument[] {
  if (!notebookId) return engine.notebooks.list();
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return [notebook.value];
}

function cellForArtifact(documents: readonly NotebookDocument[], artifactId: string): SplitSource | null {
  for (const document of documents) {
    const cell = document.cells.find((candidate) => candidate.outputArtifactId === artifactId);
    if (cell) return { document, cell, artifactId };
  }
  return null;
}

function cellById(documents: readonly NotebookDocument[], cellId: string, artifactId: string): SplitSource | null {
  for (const document of documents) {
    const cell = document.cells.find((candidate) => candidate.id === cellId);
    if (cell) return { document, cell, artifactId };
  }
  return null;
}

function findSplitSource(engine: Engine, reference: string, notebookId: string | undefined): SplitSource {
  const documents = notebookCandidates(engine, notebookId);
  const resolved = resolveNotebookArtifactReference({ engine, documents, reference });
  if ("code" in resolved) throw new Error(resolved.message);
  const source = resolved.cellId
    ? cellById(documents, resolved.cellId, resolved.artifactId)
    : cellForArtifact(documents, resolved.artifactId);
  if (!source) {
    throw new Error(`@${normalizeNotebookReference(reference)} is not on a notebook; place the video in a cell first`);
  }
  return source;
}

async function probedDuration(engine: Engine, artifactId: string): Promise<number> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const video = findVideoFile(manifest.value.files);
  if (!video) throw new Error(`No video file found in asset ${artifactId}`);
  const probe = await probeVideo(join(manifest.value.path, video.name));
  return probe.videoDuration;
}

async function detectedScenes(engine: Engine, source: SplitSource, bookId: string): Promise<SceneData> {
  const reference = source.artifactId;
  const first = await requestScenes(engine, { reference, bookId, force: false });
  if (!first.ok) throw new Error(first.error);
  if (first.scenes) return first.scenes;
  if (first.jobId !== null) await waitForBookJob(bookId, first.jobId, SCENE_WAIT_MS);
  const second = await requestScenes(engine, { reference, bookId, force: false });
  if (!second.ok) throw new Error(second.error);
  if (!second.scenes) throw new Error(`Scene detection for ${reference} did not finish`);
  return second.scenes;
}

async function chosenCuts(
  engine: Engine,
  source: SplitSource,
  args: SplitArgs,
): Promise<{ cuts: number[]; durationSeconds: number }> {
  if (args.cut_points_seconds && args.cut_points_seconds.length > 0) {
    return { cuts: args.cut_points_seconds, durationSeconds: await probedDuration(engine, source.artifactId) };
  }
  const scenes = await detectedScenes(engine, source, args.book_id);
  const options: SceneCutOptions = {
    minScore: args.min_score,
    includeSettles: args.include_settles,
    minSceneSeconds: args.min_scene_seconds,
  };
  return { cuts: selectSceneCuts(scenes, options), durationSeconds: scenes.durationSeconds };
}

async function writeSplitCells(
  engine: Engine,
  source: SplitSource,
  cuts: number[],
  durationSeconds: number,
): Promise<NotebookSplitDraft> {
  const planned: { draft: NotebookSplitDraft | null } = { draft: null };
  const result = await mutateNotebook(engine, source.document.id, "split_video_at_scenes", (document) => {
    const cell = document.cells.find((candidate) => candidate.id === source.cell.id);
    if (!cell) throw new Error("The source cell was removed");
    planned.draft = planNotebookSplit({ cutPointsSeconds: cuts, document, source: cell, sourceDurationSeconds: durationSeconds });
    return planned.draft.document;
  });
  if (!result.ok) throw new Error(result.error.message);
  if (!planned.draft) throw new Error("The split could not be planned");
  return planned.draft;
}

async function splitAtScenes(engine: Engine, args: SplitArgs): Promise<ToolResult> {
  const source = findSplitSource(engine, args.asset_id, args.notebook_id);
  const { cuts, durationSeconds } = await chosenCuts(engine, source, args);
  if (cuts.length === 0) {
    return errorResult(`No scene cuts found in @${normalizeNotebookReference(args.asset_id)}; lower min_score or include settles`);
  }
  const draft = await writeSplitCells(engine, source, cuts, durationSeconds);
  const run = await enqueueNotebookRun(engine, {
    bookId: args.book_id,
    notebookId: source.document.id,
    cellIds: [draft.actionCell.id],
    actor: args.actor ?? "videobook-user",
  });
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        source_cell: draft.sourceAddress,
        cut_points_seconds: draft.cutPointsSeconds,
        action_cell_id: draft.actionCell.id,
        output_cell_ids: draft.outputs.map((output) => output.outputCell.id),
        job_id: run.jobId,
        run_id: run.runId,
      }),
    }],
  };
}

export function splitVideoAtScenesDef(engine: Engine): ToolDef {
  return {
    name: "split_video_at_scenes",
    description:
      "Split a notebook video into one clip per scene. Detects camera cuts (reusing a cached detect_scenes result), then adds a split cell and one output cell per scene below the source and runs it. Pass cut_points_seconds to split at reviewed times instead.",
    annotations: {
      title: "Split video into scenes",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    schema: {
      asset_id: z.string().describe("Notebook cell reference such as @a1, or the video artifact id shown in a cell"),
      book_id: z.string().describe("Book UUID"),
      notebook_id: z.string().uuid().optional().describe("Notebook UUID when the reference matches cells in several notebooks"),
      min_score: z.number().min(0).max(100).optional().describe(`Minimum camera-cut score to split at (default ${DEFAULT_SCENE_MIN_SCORE}); lower finds softer cuts`),
      include_settles: z.boolean().optional().describe("Also split where motion settles inside a shot"),
      min_scene_seconds: z.number().min(0.02).optional().describe(`Shortest scene to keep (default ${DEFAULT_MIN_SCENE_SECONDS}s)`),
      cut_points_seconds: z.array(z.number().positive()).max(200).optional().describe("Explicit cut times; skips detection"),
      actor: z.string().min(1).optional(),
    },
    handler: async (args) => {
      try {
        return await splitAtScenes(engine, args as SplitArgs);
      } catch (cause) {
        return errorResult(cause instanceof Error ? cause.message : String(cause));
      }
    },
  };
}
