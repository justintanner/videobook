import { notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import type {
  Engine,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import {
  findVideoFile,
  nextHorizontalSlotFrom,
  notebookGridTag,
  resolveNotebookCellArtifactId,
} from "videobook-engine";
import { join } from "node:path";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import { mutateNotebook } from "../notebook-mutations.js";
import { resolveAudioExtractionRange } from "../notebook-media-ops.js";
import { probeVideo } from "../ffmpeg.js";
import {
  EXTRACT_AUDIO_OUTPUT_ROLE,
  findGenerationMediaOutput,
  normalizeLegacyExtractCells,
} from "../notebook-cell-outputs.js";
import { slotRight } from "../notebook-placement.js";
import { resolvePublishedPostSourceCell } from "../notebook-published-post.js";
import {
  notebookCellFingerprint,
  notebookCellMediaType,
} from "../jobs/run-notebook.js";
import type { ExtractNotebookAudioPayload } from "../jobs/extract-notebook-audio.js";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { toolError } from "./_shared.js";

function effectiveVideoSource(
  document: NotebookDocument,
  cell: NotebookCell,
): NotebookCell {
  const holder = resolvePublishedPostSourceCell(document, cell);
  const output = findGenerationMediaOutput(document, holder);
  return output?.outputCell ?? holder;
}

export function extractNotebookAudioDef(engine: Engine): ToolDef {
  return {
    name: "extract_notebook_audio",
    description:
      "Extract audio from a video cell into a new audio cell wired to its source, recording the source cell and optional time range",
    scope: "book",
    schema: {
      book_id: z.string().uuid().describe("Book UUID"),
      notebook_id: z.string().uuid().describe("Notebook holding the source cell"),
      source_cell_id: z.string().uuid()
        .describe("Video-producing cell to extract from"),
      start_seconds: z.number().min(0).optional()
        .describe("Optional range start in source seconds"),
      duration_seconds: z.number().positive().optional()
        .describe("Optional range duration in seconds"),
      label: z.string().optional().describe("Optional label for the audio cell"),
      expected_revision: z.string().min(1).optional()
        .describe("Reject the extraction when the notebook has moved past this revision"),
    },
    handler: async (args) => {
      const notebookId = String(args.notebook_id);
      const sourceCellId = String(args.source_cell_id);
      const startSeconds = typeof args.start_seconds === "number"
        ? args.start_seconds
        : undefined;
      const durationSeconds = typeof args.duration_seconds === "number"
        ? args.duration_seconds
        : undefined;
      if (
        typeof args.expected_revision === "string"
        && args.expected_revision !== engine.head
      ) {
        return toolError(
          `Stale notebook revision: expected ${args.expected_revision}`,
        );
      }
      const read = engine.notebooks.read(notebookId);
      if (!read.ok) return toolError(read.error.message);
      const document = normalizeLegacyExtractCells(read.value);
      const requested = document.cells.find((cell) =>
        cell.id === sourceCellId);
      if (!requested) {
        return toolError(`Source cell not found: ${sourceCellId}`);
      }
      const source = effectiveVideoSource(document, requested);
      if (
        notebookCellMediaType(source) !== "video"
        || source.type === "split_video"
      ) {
        return toolError(
          `${notebookGridTag(source.slot)} is not a video-producing cell`,
        );
      }
      const sourceArtifactId = resolveNotebookCellArtifactId(document, source);
      if (!sourceArtifactId) {
        return toolError(
          `${notebookGridTag(source.slot)} has no video to extract from yet`,
        );
      }

      const audioRange = startSeconds === undefined && durationSeconds === undefined
        ? undefined
        : { startSeconds: startSeconds ?? 0, ...(durationSeconds === undefined ? {} : { durationSeconds }) };
      try {
        const manifest = await engine.files.manifest(sourceArtifactId);
        if (!manifest.ok) throw new Error(manifest.error.message);
        const file = findVideoFile(manifest.value.files);
        if (!file) throw new Error("Source has no video file");
        resolveAudioExtractionRange(await probeVideo(join(manifest.value.path, file.name)), audioRange);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }

      const runId = uuidv7();
      const label = typeof args.label === "string" && args.label.length > 0
        ? args.label
        : startSeconds === undefined
          ? "Extracted audio"
          : `Audio ${startSeconds}s`;
      const placement: { cell: NotebookCell | null } = { cell: null };
      const result = await mutateNotebook(
        engine,
        notebookId,
        "extract_notebook_audio",
        (notebook) => {
          if (typeof args.expected_revision === "string" && args.expected_revision !== engine.head) {
            throw new Error(`Stale notebook revision: expected ${args.expected_revision}`);
          }
          const anchor = notebook.cells.find((cell) => cell.id === source.id);
          if (!anchor) throw new Error(`Source cell not found: ${source.id}`);
          const occupied = notebookOccupiedSlots(notebook.cells);
          const slot = nextHorizontalSlotFrom(slotRight(anchor.slot), occupied);
          const cell = engine.notebooks.createCell({
            type: "audio",
            label,
            slot,
            inputs: {
              mediaRole: EXTRACT_AUDIO_OUTPUT_ROLE,
              sourceCellId: anchor.id,
              ...(startSeconds === undefined ? {} : { startSeconds }),
              ...(durationSeconds === undefined ? {} : { durationSeconds }),
              ...(audioRange === undefined ? {} : { audioRange }),
              state: "queued",
            },
          });
          const edge = engine.notebooks.createEdge({
            source: anchor.id,
            target: cell.id,
            targetInput: "segment",
          });
          placement.cell = cell;
          const queuedAt = new Date().toISOString();
          return {
            ...notebook,
            cells: [...notebook.cells, cell],
            edges: [...notebook.edges, edge],
            execution: {
              ...(notebook.execution ?? {}),
              [cell.id]: {
                fingerprint: notebookCellFingerprint(notebook, cell),
                status: "queued",
                runId,
                startedAt: queuedAt,
                updatedAt: queuedAt,
                tool: "ffmpeg",
              },
            },
          };
        },
        { sourceCellId: source.id, runId },
      );
      if (!result.ok) return toolError(result.error.message);
      const cell = placement.cell;
      if (!cell) return toolError("Audio cell was not created");

      const address = notebookGridTag(cell.slot);
      const jobId = `extract-notebook-audio-${cell.id}`;
      const payload: ExtractNotebookAudioPayload = {
        type: "extract_notebook_audio",
        bookId: String(args.book_id),
        notebookId,
        cellId: cell.id,
        runId,
        sourceCellId: source.id,
        sourceArtifactId,
        title: `${address} · extracted audio`,
        ...(startSeconds === undefined ? {} : { startSeconds }),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      };
      await queue.enqueue(jobId, payload as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            cell_id: cell.id,
            address,
            job_id: jobId,
            run_id: runId,
            notebook_id: notebookId,
            source_cell_id: source.id,
            source_address: notebookGridTag(source.slot),
            message: `Extracting audio into ${address}`,
          }),
        }],
      };
    },
  };
}
