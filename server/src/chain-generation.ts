import { notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import type { Engine, NotebookCell } from "videobook-engine";
import { notebookGridTag } from "videobook-engine";
import { mutateNotebook } from "./notebook-mutations.js";
import {
  allocateGenerateImageResult,
  allocateGenerateVideoResult,
  allocateGenerateAudioResult,
} from "./notebook-cell-outputs.js";
import { lastCreatedCellSlot, nextGenerationOutputSlot } from "./notebook-placement.js";
import { notebookCellFingerprint } from "./jobs/run-notebook.js";
import { tryResolveModel } from "./media/descriptor.js";
import { generationLabel } from "./artifact-label.js";
import type { ChainPlacementKind, PinnedChainTarget } from "./chain-plan.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";

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
  return options !== null && typeof options === "object" && !Array.isArray(options)
    ? { generationSettings: options }
    : {};
}

function pinTargetInput(pin: PinnedChainTarget): string {
  const role = pin.field.split(".").pop() ?? pin.field;
  const field = role === "replace_audio_with" ? "replace_audio" : role;
  return pin.index === null || pin.index === 0 ? field : `${field}_${pin.index + 1}`;
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
  const produced: { producer: NotebookCell | null; outputCellId: string | null } = {
    producer: null,
    outputCellId: null,
  };
  const sourceCellIds = [...new Set(
    input.pins.flatMap((pin) => pin.cellId ? [pin.cellId] : []),
  )];
  const acceptedAt = new Date().toISOString();
  const result = await mutateNotebook(
    input.engine,
    input.notebookId,
    "chain_generation",
    (notebook) => {
      const anchors = notebook.cells.filter((cell) => sourceCellIds.includes(cell.id));
      const anchorSlot = anchors[0]?.slot
        ?? lastCreatedCellSlot(notebook.cells)
        ?? { row: 1, column: 1 };
      const occupied = notebookOccupiedSlots(notebook.cells);
      const model = producerModel(input.params);
      const producer = input.engine.notebooks.createCell({
        type: input.placement,
        label: producerLabel(input.params, input.placement),
        slot: nextGenerationOutputSlot(input.placement, anchorSlot, occupied),
        tool: input.tool,
        ...(model ? { model: model.id, provider: model.provider, operation: model.entry.operations[0]! } : {}),
        ...(typeof input.params.prompt === "string"
          ? { prompt: input.params.prompt }
          : {}),
        inputs: {
          ...producerSettings(input.params),
          chainRunId: input.runId,
        },
      });
      const provenance = input.pins.flatMap((pin) => {
        if (!pin.cellId || !anchors.some(anchor => anchor.id === pin.cellId)) return [];
        return [input.engine.notebooks.createEdge({ source: pin.cellId, target: producer.id, targetInput: pinTargetInput(pin) })];
      });
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
  return {
    producerCellId: producer.id,
    outputCellId,
    address: notebookGridTag(producer.slot),
  };
}
