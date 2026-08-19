import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { extractSourceAudio } from "../notebook-media-ops.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { notebookCellFingerprint } from "./run-notebook.js";

export type ExtractNotebookAudioPayload = {
  type: "extract_notebook_audio";
  bookId: string;
  notebookId: string;
  cellId: string;
  runId: string;
  sourceCellId: string;
  sourceArtifactId: string;
  title: string;
  startSeconds?: number;
  durationSeconds?: number;
};

async function writeAudioCellResult(
  engine: Engine,
  input: ExtractNotebookAudioPayload,
  operation: string,
  result:
    | { status: "completed"; artifactId: string; durationSeconds: number }
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
              durationSeconds: result.durationSeconds,
              sourceCellId: input.sourceCellId,
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

export function registerExtractNotebookAudioJob(engine: Engine): void {
  registerJobHandler("extract_notebook_audio", async (payload) => {
    const input = payload as unknown as ExtractNotebookAudioPayload;
    try {
      const result = await extractSourceAudio(
        engine,
        input.sourceArtifactId,
        input.title,
        input.startSeconds === undefined && input.durationSeconds === undefined
          ? undefined
          : {
              startSeconds: input.startSeconds ?? 0,
              ...(input.durationSeconds === undefined
                ? {}
                : { durationSeconds: input.durationSeconds }),
            },
      );
      await writeAudioCellResult(engine, input, "complete_extract_notebook_audio", {
        status: "completed",
        artifactId: result.artifactId,
        durationSeconds: result.durationSeconds,
      });
      return {
        success: true,
        artifactId: result.artifactId,
        durationSeconds: result.durationSeconds,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await writeAudioCellResult(engine, input, "fail_extract_notebook_audio", {
        status: "error",
        error: message,
      }).catch(() => undefined);
      throw cause;
    }
  });
}
