import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { isGenerationCreditError } from "./generation-credit-error.js";

export function creditRetryProducer(
  document: Pick<NotebookDocument, "cells" | "edges">,
  outputCellId: string,
): NotebookCell | null {
  const output = document.cells.find((cell) => cell.id === outputCellId);
  if (!output || !["image", "video", "audio"].includes(output.type)) return null;
  const edge = document.edges.find((candidate) =>
    candidate.target === output.id && candidate.targetInput === "media");
  return document.cells.find((cell) =>
    cell.id === edge?.source && cell.type === `generate_${output.type}`) ?? null;
}

export function removeCreditFailedOutput(
  engine: Engine,
  document: NotebookDocument,
  producerCellId: string,
  outputCellId: string,
): NotebookDocument {
  const producer = creditRetryProducer(document, outputCellId);
  if (producer?.id !== producerCellId) {
    throw new Error("The failed output no longer belongs to this generator");
  }
  if (producer.type === "generate_audio" && document.edges.some((edge) =>
    edge.source === producer.id && edge.targetInput === "media" && edge.target !== outputCellId
    && document.cells.some((cell) => cell.id === edge.target && cell.type === "audio"))) {
    throw new Error("This generator has another audio output; retry would replace that media");
  }
  const output = document.cells.find((cell) => cell.id === outputCellId)!;
  const state = document.execution?.[outputCellId];
  const providerArtifactId = state?.providerArtifactId ?? output.outputArtifactId;
  if (
    (output.outputArtifactId && output.outputArtifactId !== providerArtifactId)
    || (Array.isArray(output.inputs?.outputVersionArtifactIds)
      && output.inputs.outputVersionArtifactIds.some((id) => id !== providerArtifactId))
  ) {
    throw new Error("This output contains earlier media; run its generator to preserve those versions");
  }
  const failure = providerArtifactId ? engine.jobs.failures.read(providerArtifactId) : null;
  const pending = providerArtifactId ? engine.jobs.pending.read(providerArtifactId) : null;
  const message = failure?.ok && failure.value
    ? `${failure.value.message} ${failure.value.failCode ?? ""}`
    : state?.error;
  if (
    (state && state.status !== "error")
    || (providerArtifactId && (!failure?.ok || !failure.value))
    || (pending?.ok && pending.value)
    || !isGenerationCreditError(message)
  ) {
    throw new Error("Retry with deletion is only available for an out-of-credits failure");
  }
  const execution = { ...document.execution };
  delete execution[outputCellId];
  return {
    ...document,
    cells: document.cells.filter((cell) => cell.id !== outputCellId),
    edges: document.edges.filter((edge) => edge.source !== outputCellId && edge.target !== outputCellId),
    execution,
  };
}
