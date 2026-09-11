import type {
  Engine,
  NotebookCell,
  NotebookDocument,
} from "videobook-engine";
import {
  nextHorizontalSlotFrom,
  notebookGridTag,
  resolveNotebookCellArtifactId,
} from "videobook-engine";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import { mutateNotebook } from "../notebook-mutations.js";
import {
  EXTRACT_FRAME_OUTPUT_ROLE,
  findGenerationMediaOutput,
  normalizeLegacyExtractCells,
} from "../notebook-cell-outputs.js";
import { slotRight } from "../notebook-placement.js";
import { resolvePublishedPostSourceCell } from "../notebook-published-post.js";
import {
  notebookCellFingerprint,
  notebookCellMediaType,
} from "../jobs/run-notebook.js";
import type { ExtractNotebookFramePayload } from "../jobs/extract-notebook-frame.js";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { toolError } from "./_shared.js";

type FrameMode = "first" | "time" | "last";

function frameLabel(mode: FrameMode, timestampSeconds?: number): string {
  if (mode === "first") return "First frame";
  if (mode === "last") return "Last frame";
  return `Frame at ${timestampSeconds}s`;
}

function effectiveVideoSource(
  document: NotebookDocument,
  cell: NotebookCell,
): NotebookCell {
  const holder = resolvePublishedPostSourceCell(document, cell);
  const output = findGenerationMediaOutput(document, holder);
  return output?.outputCell ?? holder;
}

export function extractNotebookFrameDef(engine: Engine): ToolDef {
  return {
    name: "extract_notebook_frame",
    description:
      "Extract a frame from a video cell into a new image cell wired to its source, recording the source cell and timestamp",
    scope: "book",
    schema: {
      book_id: z.string().uuid().describe("Book UUID"),
      notebook_id: z.string().uuid().describe("Notebook holding the source cell"),
      source_cell_id: z.string().uuid()
        .describe("Video-producing cell to extract from"),
      frame_mode: z.enum(["first", "time", "last"])
        .describe("Capture the first frame, an exact timestamp, or the last frame"),
      timestamp_seconds: z.number().min(0).optional()
        .describe("Source timestamp in seconds, required when frame_mode is time"),
      label: z.string().optional().describe("Optional label for the image cell"),
      expected_revision: z.string().min(1).optional()
        .describe("Reject the extraction when the notebook has moved past this revision"),
    },
    handler: async (args) => {
      const notebookId = String(args.notebook_id);
      const sourceCellId = String(args.source_cell_id);
      const frameMode = args.frame_mode as FrameMode;
      const timestampSeconds = typeof args.timestamp_seconds === "number"
        ? args.timestamp_seconds
        : undefined;
      if (frameMode === "time" && timestampSeconds === undefined) {
        return toolError("frame_mode \"time\" requires timestamp_seconds");
      }
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

      const runId = uuidv7();
      const label = typeof args.label === "string" && args.label.length > 0
        ? args.label
        : frameLabel(frameMode, timestampSeconds);
      const placement: { cell: NotebookCell | null } = { cell: null };
      const result = await mutateNotebook(
        engine,
        notebookId,
        "extract_notebook_frame",
        (notebook) => {
          if (typeof args.expected_revision === "string" && args.expected_revision !== engine.head) {
            throw new Error(`Stale notebook revision: expected ${args.expected_revision}`);
          }
          const anchor = notebook.cells.find((cell) => cell.id === source.id);
          if (!anchor) throw new Error(`Source cell not found: ${source.id}`);
          const occupied = notebook.cells.map((cell) => cell.slot);
          const slot = nextHorizontalSlotFrom(slotRight(anchor.slot), occupied);
          const cell = engine.notebooks.createCell({
            type: "image",
            label,
            slot,
            inputs: {
              mediaRole: EXTRACT_FRAME_OUTPUT_ROLE,
              frameMode,
              ...(timestampSeconds === undefined ? {} : { timestampSeconds }),
              sourceCellId: anchor.id,
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
        { sourceCellId: source.id, frameMode, runId },
      );
      if (!result.ok) return toolError(result.error.message);
      const cell = placement.cell;
      if (!cell) return toolError("Frame cell was not created");

      const address = notebookGridTag(cell.slot);
      const jobId = `extract-notebook-frame-${cell.id}`;
      const payload: ExtractNotebookFramePayload = {
        type: "extract_notebook_frame",
        bookId: String(args.book_id),
        notebookId,
        cellId: cell.id,
        runId,
        sourceCellId: source.id,
        sourceArtifactId,
        frameMode,
        ...(timestampSeconds === undefined ? {} : { timestampSeconds }),
        title: `${address} · ${frameMode} frame`,
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
            message: `Extracting ${frameMode} frame into ${address}`,
          }),
        }],
      };
    },
  };
}
