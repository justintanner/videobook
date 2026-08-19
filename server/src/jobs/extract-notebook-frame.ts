import type { Engine } from "videobook-engine";
import { queue, registerJobHandler } from "../queue.js";
import { captureFrame } from "../notebook-media-ops.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { notebookCellFingerprint } from "./run-notebook.js";

export type ExtractNotebookFramePayload = {
  type: "extract_notebook_frame";
  bookId: string;
  notebookId: string;
  cellId: string;
  runId: string;
  sourceCellId: string;
  sourceArtifactId: string;
  frameMode: "first" | "time" | "last";
  timestampSeconds?: number;
  title: string;
};

async function writeFrameCellResult(
  engine: Engine,
  input: ExtractNotebookFramePayload,
  operation: string,
  result:
    | { status: "completed"; artifactId: string; atSeconds: number }
    | { status: "error"; error: string },
): Promise<void> {
  const written = await mutateNotebook(
    engine,
    input.notebookId,
    operation,
    (notebook) => {
      const cell = notebook.cells.find((candidate) =>
        candidate.id === input.cellId);
      if (!cell) return notebook;
      const updatedAt = new Date().toISOString();
      const updatedCell = result.status === "completed"
        ? {
            ...cell,
            outputArtifactId: result.artifactId,
            inputs: {
              ...(cell.inputs ?? {}),
              atSeconds: result.atSeconds,
              state: "completed",
            },
          }
        : {
            ...cell,
            inputs: {
              ...(cell.inputs ?? {}),
              state: "error",
            },
          };
      return {
        ...notebook,
        cells: notebook.cells.map((candidate) =>
          candidate.id === input.cellId ? updatedCell : candidate),
        execution: {
          ...(notebook.execution ?? {}),
          [input.cellId]: {
            fingerprint: notebookCellFingerprint(notebook, updatedCell),
            status: result.status,
            runId: input.runId,
            ...(result.status === "completed"
              ? { outputArtifactId: result.artifactId, completedAt: updatedAt }
              : { error: result.error }),
            updatedAt,
            tool: "ffmpeg",
          },
        },
      };
    },
    { cellId: input.cellId, runId: input.runId },
    result.status === "completed" ? { artifactId: result.artifactId } : {},
  );
  if (!written.ok) throw new Error(written.error.message);
}

export function registerExtractNotebookFrameJob(engine: Engine): void {
  registerJobHandler("extract_notebook_frame", async (payload) => {
    const input = payload as unknown as ExtractNotebookFramePayload;
    try {
      const result = await captureFrame(engine, input.sourceArtifactId, {
        role: input.frameMode,
        ...(input.frameMode === "time"
          && typeof input.timestampSeconds === "number"
          ? { timestampSeconds: input.timestampSeconds }
          : {}),
        title: input.title,
      });
      await queue.enqueue(`process-image-${result.artifactId}-${Date.now()}`, {
        type: "process_image",
        assetId: result.artifactId,
        bookId: input.bookId,
        extension: ".jpg",
        provenance: {
          origin: "extract_frame",
          sourceArtifactId: input.sourceArtifactId,
          frameMode: input.frameMode,
          atSeconds: result.atSeconds,
        },
      } as unknown as Record<string, unknown>);
      await writeFrameCellResult(engine, input, "complete_extract_notebook_frame", {
        status: "completed",
        artifactId: result.artifactId,
        atSeconds: result.atSeconds,
      });
      return {
        success: true,
        artifactId: result.artifactId,
        atSeconds: result.atSeconds,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await writeFrameCellResult(engine, input, "fail_extract_notebook_frame", {
        status: "error",
        error: message,
      }).catch(() => undefined);
      throw cause;
    }
  });
}
