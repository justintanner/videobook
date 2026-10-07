import { notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import type { Engine, NotebookCell } from "videobook-engine";
import { notebookGridTag } from "videobook-engine";
import { mutateNotebook } from "./notebook-mutations.js";
import {
  allocateGenerateImageResult,
  allocateGenerateVideoResult,
} from "./notebook-cell-outputs.js";
import { lastCreatedCellSlot, nextGenerationOutputSlot } from "./notebook-placement.js";
import { notebookCellFingerprint } from "./jobs/run-notebook.js";
import { getActionSpec } from "./generation-registry.js";
import { generationLabel } from "./artifact-label.js";
import type { ChainPlacementKind, PinnedChainTarget } from "./chain-plan.js";

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

/** Generation settings worth keeping on the producer cell for re-run and display. */
const SETTING_KEYS = [
  "duration",
  "resolution",
  "aspect_ratio",
  "output_format",
  "generate_audio",
] as const;

function producerLabel(
  tool: string,
  placement: ChainPlacementKind,
  prompt: unknown,
): string {
  const spec = getActionSpec(tool);
  const model = spec
    ? spec.apicity_identifier
    : placement === "generate_video" ? "Generate video" : "Generate image";
  return generationLabel(model, typeof prompt === "string" ? prompt : undefined);
}

function producerSettings(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    SETTING_KEYS.flatMap((key) =>
      params[key] === undefined ? [] : [[key, params[key]] as const]),
  );
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
      const producer = input.engine.notebooks.createCell({
        type: input.placement,
        label: producerLabel(input.tool, input.placement, input.params.prompt),
        slot: nextGenerationOutputSlot(input.placement, anchorSlot, occupied),
        tool: input.tool,
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
        const field = pin.field.replace(/_refs?$/u, "").replace(/^replace_audio_with$/u, "replace_audio");
        const targetInput = pin.index === null || pin.index === 0 ? field : `${field}_${pin.index + 1}`;
        return [input.engine.notebooks.createEdge({ source: pin.cellId, target: producer.id, targetInput })];
      });
      const withProducer = {
        ...notebook,
        cells: [...notebook.cells, producer],
        edges: [...notebook.edges, ...provenance],
      };
      const allocate = input.placement === "generate_video"
        ? allocateGenerateVideoResult
        : allocateGenerateImageResult;
      const allocated = allocate(input.engine, withProducer, producer.id, {
        runId: input.runId,
        acceptedAt,
        artifactId: input.artifactId,
        state: "awaiting-output",
      });
      produced.producer = producer;
      produced.outputCellId = allocated.outputCell.id;
      return {
        ...allocated.document,
        execution: {
          ...(allocated.document.execution ?? {}),
          [allocated.outputCell.id]: {
            fingerprint: notebookCellFingerprint(allocated.document, producer),
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
