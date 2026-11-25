import type { Engine, NotebookCell } from "videobook-engine";
import { notebookGridTag } from "videobook-engine";
import { mutateNotebook, withNotebookMutation } from "./notebook-mutations.js";
import { generationInputPort } from "./generation-input-targets.js";
import {
  allocateGenerateImageResult,
  allocateGenerateVideoResult,
  allocateGenerateAudioResult,
} from "./notebook-cell-outputs.js";
import { placeNewGenerator } from "./notebook-rounds-placement.js";
import { notebookCellFingerprint } from "./jobs/run-notebook.js";
import { tryResolveModel } from "./media/descriptor.js";
import { generationLabel } from "./artifact-label.js";
import type { ChainPlacementKind, PinnedChainTarget } from "./chain-plan.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";
import type { GoalGenerationOrigin } from "./goal-generation-provenance.js";

export type ChainGenerationPlacement = {
  producerCellId: string;
  outputCellId: string;
  address: string;
};

export type ChainGenerationPlacementInput = {
  engine: Engine;
  notebookId: string;
  tool: string;
  placement: ChainPlacementKind;
  /** Dispatch-ready params: refs substituted, pins applied. */
  params: Record<string, unknown>;
  artifactId: string;
  runId: string;
  pins: readonly PinnedChainTarget[];
  goalOrigin?: GoalGenerationOrigin;
};

function producerModel(params: Record<string, unknown>) {
  return typeof params.model === "string" ? tryResolveModel(params.model) : null;
}

function producerLabel(
  params: Record<string, unknown>,
  placement: ChainPlacementKind,
): string {
  const title = producerModel(params)?.title
    ?? { generate_video: "Generate video", generate_image: "Generate image", generate_audio: "Generate audio" }[placement];
  return generationLabel(title, typeof params.prompt === "string" ? params.prompt : undefined);
}

function producerSettings(params: Record<string, unknown>): Record<string, unknown> {
  const options = params.options;
  const mode = typeof params.mode === "string" && params.mode.trim() !== "" ? params.mode.trim() : null;
  return {
    ...(options !== null && typeof options === "object" && !Array.isArray(options) ? { generationSettings: options } : {}),
    ...(mode ? { generationMode: mode } : {}),
  };
}

function pinTargetInput(pin: PinnedChainTarget): string {
  const role = pin.field.split(".").pop() ?? pin.field;
  const field = pin.field.startsWith("field_refs.")
    ? `slot:${role}`
    : role === "replace_audio_with" ? "replace_audio" : role;
  return generationInputPort(field, (pin.index ?? 0) + 1);
}

/**
 * Put a chained generation on the grid the same way a notebook run does: a
 * producer cell recording what was asked for, an output cell holding the
 * artifact, and a media edge joining them. Without this the artifact exists but
 * nothing on the board points at it, so no later step can consume it.
 */
export async function placeChainGeneration(
  input: ChainGenerationPlacementInput,
): Promise<ChainGenerationPlacement> {
  return withNotebookMutation(`chain-placement:${input.runId}`, () => placeGeneration(input));
}

async function placeGeneration(input: ChainGenerationPlacementInput): Promise<ChainGenerationPlacement> {
  const produced: { producer: NotebookCell | null; outputCellId: string | null } = {
    producer: null,
    outputCellId: null,
  };
  const acceptedAt = new Date().toISOString();
  const result = await mutateNotebook(
    input.engine,
    input.notebookId,
    "chain_generation",
    (notebook) => {
      const existing = notebook.cells.find(cell => {
        if (cell.inputs?.chainRunId !== input.runId) return false;
        const attempts = input.engine.generations.listForCell(input.notebookId, cell.id);
        if (!attempts.ok) throw new Error(attempts.error.message);
        return attempts.value.some(attempt => attempt.providerArtifactId === input.artifactId && attempt.runId === input.runId)
          || notebook.cells.some(output => (output.id === cell.id || output.inputs?.producerCellId === cell.id)
            && (output.outputArtifactId === input.artifactId || notebook.execution?.[output.id]?.providerArtifactId === input.artifactId));
      });
      if (existing) {
        const output = input.placement === "generate_audio" ? existing : notebook.cells.find(cell =>
          cell.inputs?.producerCellId === existing.id && cell.inputs?.generationRunId === input.runId
          && (cell.outputArtifactId === input.artifactId || notebook.execution?.[cell.id]?.providerArtifactId === input.artifactId));
        if (!output || notebook.execution?.[output.id]?.runId !== input.runId) {
          throw new Error("The saved generation placement changed. Review its existing take before continuing.");
        }
        produced.producer = existing;
        produced.outputCellId = output.id;
        return notebook;
      }
      const anchors = input.pins.flatMap((pin) => {
        const anchor = notebook.cells.find(cell => pin.cellId ? cell.id === pin.cellId : cell.outputArtifactId === pin.artifactId);
        return anchor ? [{ anchor, pin }] : [];
      });
      const model = producerModel(input.params);
      const producer = input.engine.notebooks.createCell({
        type: input.placement,
        label: producerLabel(input.params, input.placement),
        slot: placeNewGenerator(notebook, anchors.map(({ anchor }) => anchor.id)),
        tool: input.tool,
        ...(model ? { model: model.id, provider: model.provider, operation: model.entry.operations[0]! } : {}),
        ...(typeof input.params.prompt === "string"
          ? { prompt: input.params.prompt }
          : {}),
        inputs: {
          ...producerSettings(input.params),
          chainRunId: input.runId,
          ...(input.goalOrigin ? { goalOrigin: input.goalOrigin } : {}),
        },
      });
      const provenance = anchors.map(({ anchor, pin }) =>
        input.engine.notebooks.createEdge({ source: anchor.id, target: producer.id, targetInput: pinTargetInput(pin) }));
      const withProducer = {
        ...notebook,
        cells: [...notebook.cells, producer],
        edges: [...notebook.edges, ...provenance],
      };
      const allocate = {
        generate_video: allocateGenerateVideoResult,
        generate_image: allocateGenerateImageResult,
        generate_audio: allocateGenerateAudioResult,
      }[input.placement];
      const allocated = allocate(input.engine, withProducer, producer.id, {
        runId: input.runId,
        acceptedAt,
        artifactId: input.artifactId,
        state: "awaiting-output",
      });
      const arranged = arrangeGoalNotebook(allocated.document);
      produced.producer = arranged.cells.find(cell => cell.id === producer.id)!;
      produced.outputCellId = allocated.outputCell.id;
      return {
        ...arranged,
        execution: {
          ...(arranged.execution ?? {}),
          [input.placement === "generate_audio" ? producer.id : allocated.outputCell.id]: {
            fingerprint: notebookCellFingerprint(arranged, produced.producer),
            status: "awaiting-output",
            runId: input.runId,
            providerArtifactId: input.artifactId,
            startedAt: acceptedAt,
            updatedAt: acceptedAt,
            tool: input.tool,
          },
        },
      };
    },
    { tool: input.tool, runId: input.runId, artifactId: input.artifactId },
  );
  if (!result.ok) throw new Error(result.error.message);
  const producer = produced.producer;
  const outputCellId = produced.outputCellId;
  if (!producer || !outputCellId) {
    throw new Error(`${input.tool} produced no notebook cell`);
  }
  const existing = input.engine.generations.listForCell(input.notebookId, producer.id);
  if (!existing.ok) throw new Error(existing.error.message);
  if (!existing.value.some(generation => generation.providerArtifactId === input.artifactId && generation.runId === input.runId)) {
    const model = producerModel(input.params);
    const recorded = await input.engine.generations.record({
      notebookId: input.notebookId, cellId: producer.id, outputCellId, runId: input.runId,
      tool: input.tool, status: "awaiting_provider", providerArtifactId: input.artifactId,
      ...(model ? { model: model.id, provider: model.provider } : {}),
      ...(typeof input.params.prompt === "string" ? { prompt: input.params.prompt, resolvedPrompt: input.params.prompt } : {}),
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
  }
  return {
    producerCellId: producer.id,
    outputCellId,
    address: notebookGridTag(producer.slot),
  };
}
