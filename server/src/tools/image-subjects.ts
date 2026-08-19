import { createHash } from "node:crypto";
import { z } from "zod";
import type { Engine, Job, NotebookCell } from "videobook-engine";
import { nextHorizontalSlotFrom } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import {
  IMAGE_SUBJECT_MAP_VERSION,
  imageSubjectMapResponse,
  readImageSubjectMapRecord,
  resolveImageSubjectSource,
  subjectAnalysisProviderFailureMessage,
  writeCurrentImageSubjectAnalysisRecord,
  writeImageSubjectMapRecord,
  type ImageSubjectMapRecordV1,
} from "../image-subject-map.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { slotRight } from "../notebook-placement.js";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

function failure(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function sourceCellAcceptsArtifact(cell: NotebookCell, artifactId: string): boolean {
  if (cell.outputArtifactId === artifactId) return true;
  return Array.isArray(cell.inputs?.outputVersionArtifactIds)
    && cell.inputs.outputVersionArtifactIds.includes(artifactId);
}

function uniqueSubjectIds(value: readonly string[]): string[] {
  return [...new Set(value)];
}

export function reuseImageSubjectAnalysis(
  record: Awaited<ReturnType<typeof readImageSubjectMapRecord>>,
  objectHash: string,
  force: boolean,
  active: boolean,
): boolean {
  return record?.objectHash === objectHash
    && (
      (record.status === "analyzing" && active)
      || (record.status === "ready" && !force)
    );
}

const ACTIVE_IMAGE_SUBJECT_ANALYSIS_STATES = new Set([
  "queued",
  "running",
  "completing",
]);

function matchingImageSubjectAnalysisJobs(
  engine: Engine,
  record: ImageSubjectMapRecordV1,
): Job[] {
  return engine.jobs.queue.list({
    states: ["queued", "running", "completing", "done", "failed", "aborted"],
    type: "analyze_image_subjects",
  }).filter((job) =>
    job.payload.jobId === record.jobId
    && job.payload.sourceArtifactId === record.artifactId
    && job.payload.sourceObjectHash === record.objectHash);
}

function terminalJobError(job: Job): string | null {
  if (job.error?.message) return job.error.message;
  if (!job.result || typeof job.result !== "object" || Array.isArray(job.result)) {
    return null;
  }
  const result = job.result as Record<string, unknown>;
  if (typeof result.error === "string" && result.error.trim()) {
    return result.error.trim();
  }
  if (
    result.error
    && typeof result.error === "object"
    && !Array.isArray(result.error)
    && typeof (result.error as Record<string, unknown>).message === "string"
  ) {
    return ((result.error as Record<string, unknown>).message as string).trim() || null;
  }
  return result.success === false && typeof result.message === "string"
    ? result.message.trim() || null
    : null;
}

function projectedSubjectAnalysisError(detail: string, state: Job["state"]): string {
  const normalized = detail.trim();
  if (/^internal error[.!]?$/iu.test(normalized)) {
    return subjectAnalysisProviderFailureMessage(normalized);
  }
  if (normalized.startsWith("Subject analysis provider failed:")) {
    return normalized;
  }
  const withoutPeriod = normalized.replace(/[.\s]+$/u, "");
  const lower = withoutPeriod.toLowerCase();
  if (
    lower.includes("did not finish within")
    || lower.includes("deadline")
    || lower.includes("lease expired")
  ) {
    if (lower.includes("retry")) return normalized;
    return `${withoutPeriod}. Retry the analysis.`;
  }
  return `Subject analysis job ${state}: ${withoutPeriod}. Retry the analysis.`;
}

function projectImageSubjectAnalysisRecord(
  engine: Engine,
  record: ImageSubjectMapRecordV1 | null,
): ImageSubjectMapRecordV1 | null {
  if (record?.status === "failed" && /^internal error[.!]?$/iu.test(record.error.trim())) {
    return {
      ...record,
      error: subjectAnalysisProviderFailureMessage(record.error),
    };
  }
  if (record?.status !== "analyzing") return record;
  const jobs = matchingImageSubjectAnalysisJobs(engine, record);
  if (jobs.some((job) => ACTIVE_IMAGE_SUBJECT_ANALYSIS_STATES.has(job.state))) {
    return record;
  }
  const terminal = jobs.find((job) =>
    job.state === "failed" || job.state === "aborted" || job.state === "done");
  const detail = terminal ? terminalJobError(terminal) : null;
  const error = detail
    ? projectedSubjectAnalysisError(detail, terminal!.state)
    : terminal?.state === "done"
      ? "Subject analysis completed without publishing subjects. Retry the analysis."
      : terminal
        ? `Subject analysis job ${terminal.state}. Retry the analysis.`
        : "Subject analysis is no longer active. Retry the analysis.";
  return {
    version: IMAGE_SUBJECT_MAP_VERSION,
    status: "failed",
    artifactId: record.artifactId,
    objectHash: record.objectHash,
    width: record.width,
    height: record.height,
    jobId: record.jobId,
    error,
    failedAt: terminal?.finishedAt
      ? new Date(terminal.finishedAt).toISOString()
      : new Date().toISOString(),
    ...(record.taskId ? { taskId: record.taskId } : {}),
  };
}

export function imageSubjectAnalysisResumeTaskId(
  record: ImageSubjectMapRecordV1 | null,
  objectHash: string,
  active: boolean,
): string | undefined {
  return record?.status === "analyzing"
    && record.objectHash === objectHash
    && active
    ? record.taskId
    : undefined;
}

export function imageSubjectAnalysisJobIsActive(
  engine: Engine,
  jobId: string,
): boolean {
  return engine.jobs.queue.list({
    states: ["queued", "running", "completing"],
    type: "analyze_image_subjects",
  }).some((job) => job.payload.jobId === jobId);
}

export function imageSubjectAnalysisJobId(
  artifactId: string,
  objectHash: string,
  priorJobId: string | null,
  force: boolean,
): string {
  const key = `${artifactId}:${objectHash}`;
  const seed = force || priorJobId
    ? `${key}:retry:${priorJobId ?? "none"}`
    : `${key}:v${IMAGE_SUBJECT_MAP_VERSION}`;
  return `image-subject-analysis-${createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 24)}`;
}

async function rollbackEditPlacement(
  engine: Engine,
  notebookId: string,
  producerCellId: string,
  outputCellId: string,
): Promise<void> {
  await mutateNotebook(
    engine,
    notebookId,
    "rollback_image_subject_edit",
    (notebook) => {
      const removed = new Set([producerCellId, outputCellId]);
      const execution = { ...(notebook.execution ?? {}) };
      delete execution[producerCellId];
      delete execution[outputCellId];
      return {
        ...notebook,
        cells: notebook.cells.filter((cell) => !removed.has(cell.id)),
        edges: notebook.edges.filter((edge) =>
          !removed.has(edge.source) && !removed.has(edge.target)),
        execution,
      };
    },
    { producerCellId, outputCellId },
  );
}

export function imageSubjectDefs(engine: Engine): ToolDef[] {
  return [
    {
      name: "get_image_subject_map",
      description: "Read cached automatic image subjects without starting provider work",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      schema: {
        book_id: z.string().min(1),
        artifact_id: z.string().min(1),
        object_hash: z.string().min(1),
      },
      handler: async (args) => {
        const { book_id, artifact_id, object_hash } = args as {
          book_id: string;
          artifact_id: string;
          object_hash: string;
        };
        try {
          const source = await resolveImageSubjectSource(engine, artifact_id);
          if (source.objectHash !== object_hash) {
            return failure("The requested image version is stale; refresh the asset before editing");
          }
          const record = await readImageSubjectMapRecord(engine, artifact_id);
          const projected = projectImageSubjectAnalysisRecord(engine, record);
          return json(imageSubjectMapResponse(book_id, source, projected));
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "analyze_image_subjects",
      description: "Automatically decompose an image into cached subjects using Seedream 5 Pro",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      schema: {
        book_id: z.string().min(1),
        artifact_id: z.string().min(1),
        object_hash: z.string().min(1),
        force: z.boolean().optional(),
      },
      handler: async (args) => {
        const { book_id, artifact_id, object_hash, force } = args as {
          book_id: string;
          artifact_id: string;
          object_hash: string;
          force?: boolean;
        };
        try {
          const source = await resolveImageSubjectSource(engine, artifact_id);
          if (source.objectHash !== object_hash) {
            return failure("The requested image version is stale; refresh the asset before analyzing");
          }
          const existing = await readImageSubjectMapRecord(engine, artifact_id);
          const active = existing?.status === "analyzing"
            && imageSubjectAnalysisJobIsActive(engine, existing.jobId);
          if (reuseImageSubjectAnalysis(existing, object_hash, force === true, active)) {
            return json(imageSubjectMapResponse(book_id, source, existing));
          }
          if (!process.env.KIE_API_KEY) {
            return failure("KIE_API_KEY environment variable is not set");
          }
          const jobId = imageSubjectAnalysisJobId(
            artifact_id,
            object_hash,
            existing?.jobId ?? null,
            force === true,
          );
          const resumeTaskId = imageSubjectAnalysisResumeTaskId(
            existing,
            object_hash,
            active,
          );
          const analyzing = {
            version: 1 as const,
            status: "analyzing" as const,
            artifactId: artifact_id,
            objectHash: object_hash,
            width: source.width,
            height: source.height,
            jobId,
            startedAt: new Date().toISOString(),
            ...(resumeTaskId
              ? { taskId: resumeTaskId }
              : {}),
          };
          await writeImageSubjectMapRecord(engine, analyzing);
          try {
            await queue.enqueue(jobId, {
              type: "analyze_image_subjects",
              sourceArtifactId: artifact_id,
              sourceObjectHash: object_hash,
              bookId: book_id,
              jobId,
              ...(analyzing.taskId ? { resumeTaskId: analyzing.taskId } : {}),
            });
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            await writeCurrentImageSubjectAnalysisRecord(engine, {
              version: 1,
              status: "failed",
              artifactId: artifact_id,
              objectHash: object_hash,
              width: source.width,
              height: source.height,
              jobId,
              error: message.slice(0, 800) || "Failed to enqueue subject analysis",
              failedAt: new Date().toISOString(),
            }).catch(() => undefined);
            throw cause;
          }
          const afterEnqueue = await readImageSubjectMapRecord(engine, artifact_id);
          const projected = projectImageSubjectAnalysisRecord(engine, afterEnqueue);
          return json(imageSubjectMapResponse(book_id, source, projected));
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    {
      name: "edit_image_subjects",
      description: "Remove or semantically edit selected cached image subjects into a new connected notebook image",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      schema: {
        book_id: z.string().min(1),
        notebook_id: z.string().uuid(),
        source_cell_id: z.string().uuid(),
        artifact_id: z.string().min(1),
        object_hash: z.string().min(1),
        subject_ids: z.array(z.string().min(1)).min(1),
        operation: z.enum(["remove", "edit"]),
        prompt: z.string().max(2400).optional(),
      },
      handler: async (args) => {
        const {
          book_id,
          notebook_id,
          source_cell_id,
          artifact_id,
          object_hash,
          subject_ids,
          operation,
          prompt,
        } = args as {
          book_id: string;
          notebook_id: string;
          source_cell_id: string;
          artifact_id: string;
          object_hash: string;
          subject_ids: string[];
          operation: "remove" | "edit";
          prompt?: string;
        };
        if (operation === "edit" && !prompt?.trim()) {
          return failure("A prompt is required to edit selected subjects");
        }
        if (operation === "edit" && !process.env.KIE_API_KEY) {
          return failure("KIE_API_KEY environment variable is not set");
        }
        try {
          const source = await resolveImageSubjectSource(engine, artifact_id);
          if (source.objectHash !== object_hash) {
            return failure("The requested image version is stale; refresh the asset before editing");
          }
          const map = await readImageSubjectMapRecord(engine, artifact_id);
          if (!map || map.status !== "ready" || map.objectHash !== object_hash) {
            return failure("Analyze image subjects before editing them");
          }
          const selectedIds = uniqueSubjectIds(subject_ids);
          const subjects = new Map(map.subjects.map((subject) => [subject.id, subject]));
          const unknown = selectedIds.filter((id) => !subjects.has(id));
          if (unknown.length > 0) {
            return failure(`Unknown subject ids: ${unknown.join(", ")}`);
          }
          const notebook = engine.notebooks.read(notebook_id);
          if (!notebook.ok) return failure(notebook.error.message);
          const sourceCell = notebook.value.cells.find((cell) => cell.id === source_cell_id);
          if (!sourceCell || !sourceCellAcceptsArtifact(sourceCell, artifact_id)) {
            return failure("The pinned source cell does not contain the requested image version");
          }
          const labels = selectedIds.map((id) => subjects.get(id)!.label);
          const generatedPrompt = prompt?.trim()
            || `Remove ${labels.join(", ")}`;
          const actionLabel = operation === "remove"
            ? `Remove ${labels.join(", ")}`
            : `Edit ${labels.join(", ")}`;
          const outputLabel = operation === "remove"
            ? `Image without ${labels.join(", ")}`
            : `Edited ${labels.join(", ")}`;
          const provider = operation === "remove" ? "local" : "kie";
          const model = operation === "remove"
            ? "sharp/layer-composite"
            : "seedream/5-pro-image-to-image";
          const sourceArtifact = engine.artifacts.get(artifact_id);
          const output = await engine.artifacts.create({
            kind: "image",
            label: sourceArtifact.ok && sourceArtifact.value.label
              ? `${sourceArtifact.value.label} ${operation === "remove" ? "without" : "edited"} ${labels.join(", ")}`
              : outputLabel,
          });
          if (!output.ok) return failure(output.error.message);
          const imageAssetId = output.value.artifactId;
          const jobId = `image-subject-${operation}-${imageAssetId}`;
          const placed: { producer: NotebookCell | null; output: NotebookCell | null } = {
            producer: null,
            output: null,
          };
          let generationId: string | null = null;
          try {
            const written = await mutateNotebook(
              engine,
              notebook_id,
              "enqueue_image_subject_edit",
              (current) => {
                const currentSource = current.cells.find((cell) => cell.id === source_cell_id);
                if (!currentSource || !sourceCellAcceptsArtifact(currentSource, artifact_id)) {
                  throw new Error("The pinned source cell changed before placement");
                }
                const occupied = current.cells.map((cell) => cell.slot);
                const producer = engine.notebooks.createCell({
                  type: "generate_image",
                  label: actionLabel,
                  slot: nextHorizontalSlotFrom(slotRight(currentSource.slot), occupied),
                  prompt: generatedPrompt,
                  provider,
                  model,
                  operation: "image_to_image",
                  tool: "edit_image_subjects",
                  inputs: {
                    generationMode: operation === "remove"
                      ? "subject-remove"
                      : "subject-edit",
                    sourceArtifactId: artifact_id,
                    sourceObjectHash: object_hash,
                    subjectIds: selectedIds,
                    subjectMapVersion: IMAGE_SUBJECT_MAP_VERSION,
                    state: "queued",
                  },
                });
                const outputCell = engine.notebooks.createCell({
                  type: "image",
                  label: outputLabel,
                  slot: nextHorizontalSlotFrom(
                    slotRight(producer.slot),
                    [...occupied, producer.slot],
                  ),
                  outputArtifactId: imageAssetId,
                  inputs: {
                    mediaRole: "generate-image-output",
                    producerCellId: producer.id,
                    state: "queued",
                  },
                });
                placed.producer = producer;
                placed.output = outputCell;
                return {
                  ...current,
                  cells: [...current.cells, producer, outputCell],
                  edges: [
                    ...current.edges,
                    engine.notebooks.createEdge({
                      source: currentSource.id,
                      target: producer.id,
                      targetInput: "image",
                    }),
                    engine.notebooks.createEdge({
                      source: producer.id,
                      target: outputCell.id,
                      targetInput: "media",
                    }),
                  ],
                  execution: {
                    ...(current.execution ?? {}),
                    [producer.id]: {
                      status: "queued",
                      outputArtifactId: imageAssetId,
                      providerArtifactId: imageAssetId,
                      runId: jobId,
                      updatedAt: new Date().toISOString(),
                      tool: "edit_image_subjects",
                    },
                    [outputCell.id]: {
                      status: "queued",
                      outputArtifactId: imageAssetId,
                      runId: jobId,
                      updatedAt: new Date().toISOString(),
                      tool: "edit_image_subjects",
                    },
                  },
                };
              },
              {
                sourceCellId: source_cell_id,
                sourceArtifactId: artifact_id,
                outputArtifactId: imageAssetId,
                subjectIds: selectedIds,
              },
              { artifactId: imageAssetId },
            );
            if (!written.ok) throw new Error(written.error.message);
            if (!placed.producer || !placed.output) {
              throw new Error("Subject removal cells were not placed");
            }
            const producer = placed.producer;
            const outputCell = placed.output;
            const generation = await engine.generations.record({
              notebookId: notebook_id,
              cellId: producer.id,
              outputCellId: outputCell.id,
              runId: jobId,
              status: "dispatched",
              tool: "edit_image_subjects",
              provider,
              model,
              prompt: generatedPrompt,
              providerArtifactId: imageAssetId,
            });
            if (!generation.ok) throw new Error(generation.error.message);
            generationId = generation.value.generationId;
            await queue.enqueue(jobId, {
              type: "generate_image_subject_edit",
              imageAssetId,
              sourceArtifactId: artifact_id,
              sourceObjectHash: object_hash,
              subjectIds: selectedIds,
              operation,
              prompt: generatedPrompt,
              bookId: book_id,
              notebookId: notebook_id,
              producerCellId: producer.id,
              outputCellId: outputCell.id,
              generationId,
              jobId,
            });
            return json({
              status: "enqueued",
              operation,
              job_id: jobId,
              source_artifact_id: artifact_id,
              output_artifact_id: imageAssetId,
              producer_cell_id: producer.id,
              output_cell_id: outputCell.id,
              output_address: notebookGridTag(outputCell.slot),
            });
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            if (generationId) {
              await engine.generations.update(generationId, {
                status: "failed",
                error: message,
              }).catch(() => undefined);
            }
            const producer = placed.producer;
            const outputCell = placed.output;
            if (producer && outputCell) {
              await rollbackEditPlacement(
                engine,
                notebook_id,
                producer.id,
                outputCell.id,
              ).catch(() => undefined);
            }
            await engine.artifacts.delete(imageAssetId).catch(() => undefined);
            throw cause;
          }
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
  ];
}
