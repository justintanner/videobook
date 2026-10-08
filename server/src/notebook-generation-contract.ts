import type { NotebookCell, NotebookDocument } from "videobook-engine";
import { readSlotConstraints } from "./zod-slots.js";
import { generationModeInputError } from "./generation-input-policy.js";
import { getActionSpec } from "./generation-registry.js";

type NotebookGenerationInputKind = "image" | "video" | "audio";

interface NotebookGenerationInputSlot {
  field: string;
  kind: NotebookGenerationInputKind;
  targets: string[];
  min: number;
  max: number | null;
}

interface NotebookGenerationInputMode {
  id: string;
  slots: NotebookGenerationInputSlot[];
  requiredGroups: string[][];
}

export interface NotebookGenerationInputContract {
  modes: NotebookGenerationInputMode[];
}

type ConnectedInput = {
  kind: NotebookGenerationInputKind;
  target: string;
};

type InputFieldSpec = {
  kind: NotebookGenerationInputKind;
  targets: string[];
};

const inputFieldSpecs: Record<string, InputFieldSpec> = {
  character_image_refs: {
    kind: "image",
    targets: ["image"],
  },
  image_refs: {
    kind: "image",
    targets: ["image"],
  },
  image_ref: {
    kind: "image",
    targets: ["image"],
  },
  first_frame_ref: { kind: "image", targets: ["first_frame"] },
  last_frame_ref: { kind: "image", targets: ["last_frame"] },
  end_frame_ref: { kind: "image", targets: ["last_frame"] },
  video_refs: { kind: "video", targets: ["video"] },
  motion_video_refs: { kind: "video", targets: ["video"] },
  video_ref: { kind: "video", targets: ["video"] },
  first_clip_ref: { kind: "video", targets: ["video"] },
  audio_refs: { kind: "audio", targets: ["audio"] },
  audio_ref: { kind: "audio", targets: ["audio"] },
  driving_audio_ref: { kind: "audio", targets: ["audio"] },
  replace_audio_with: { kind: "audio", targets: ["replace_audio"] },
};

function inputSlots(schema: Record<string, unknown>): NotebookGenerationInputSlot[] {
  return Object.entries(inputFieldSpecs).flatMap(([field, spec]) => {
    const fieldSchema = schema[field];
    if (!fieldSchema) return [];
    const constraints = readSlotConstraints(
      fieldSchema as unknown as { _def?: unknown },
    );
    if (!constraints) return [];
    return [{
      field,
      kind: spec.kind,
      targets: spec.targets,
      min: constraints.min,
      max: constraints.max,
    }];
  });
}

function slotsByField(
  slots: readonly NotebookGenerationInputSlot[],
  fields: readonly string[],
): NotebookGenerationInputSlot[] {
  const fieldSet = new Set(fields);
  return slots.filter((slot) => fieldSet.has(slot.field));
}

function mode(
  id: string,
  slots: NotebookGenerationInputSlot[],
  requiredGroups: string[][] = [],
): NotebookGenerationInputMode {
  return { id, slots, requiredGroups };
}

function seedanceContract(
  tool: string,
  slots: readonly NotebookGenerationInputSlot[],
): NotebookGenerationInputContract {
  const replacement = slotsByField(slots, ["replace_audio_with"]);
  const references = slotsByField(
    slots,
    ["image_refs", "video_refs", "audio_refs", "replace_audio_with"],
  );
  if (tool === "generate_kie_seedance_2_0_mini_video") {
    return {
      modes: [
        mode("t2v", replacement),
        mode(
          "r2v",
          references,
          [["image_refs", "video_refs", "audio_refs"]],
        ),
      ],
    };
  }
  const frames = slotsByField(
    slots,
    ["first_frame_ref", "last_frame_ref", "replace_audio_with"],
  );
  return {
    modes: [
      mode("t2v", replacement),
      mode(
        "i2v",
        frames,
        [["first_frame_ref", "last_frame_ref"]],
      ),
      mode(
        "r2v",
        references,
        [["image_refs", "video_refs", "audio_refs"]],
      ),
    ],
  };
}

function kieOmniContract(
  slots: readonly NotebookGenerationInputSlot[],
): NotebookGenerationInputContract {
  return {
    modes: [
      mode("t2v", []),
      mode(
        "r2v",
        slotsByField(slots, ["image_refs"]),
        [["image_refs"]],
      ),
      mode(
        "v2v",
        slotsByField(slots, ["video_ref", "image_refs"]),
        [["video_ref"]],
      ),
    ],
  };
}

function googleOmniContract(
  slots: readonly NotebookGenerationInputSlot[],
): NotebookGenerationInputContract {
  return {
    modes: [
      mode("t2v", []),
      mode(
        "i2v",
        slotsByField(slots, ["first_frame_ref"]),
        [["first_frame_ref"]],
      ),
      mode(
        "r2v",
        slotsByField(slots, ["image_refs"]),
        [["image_refs"]],
      ),
      mode(
        "v2v",
        slotsByField(slots, ["video_ref", "image_refs"]),
        [["video_ref"]],
      ),
    ],
  };
}

function wan30Contract(
  slots: readonly NotebookGenerationInputSlot[],
): NotebookGenerationInputContract {
  return {
    modes: [
      mode("t2v", []),
      mode(
        "i2v",
        slotsByField(slots, ["first_frame_ref", "last_frame_ref"]),
        [["first_frame_ref", "last_frame_ref"]],
      ),
      mode(
        "r2v",
        slotsByField(slots, ["image_refs", "video_refs", "audio_refs"]),
        [["image_refs", "video_refs", "audio_refs"]],
      ),
    ],
  };
}

export function notebookGenerationInputContract(
  tool: string,
  schema: Record<string, unknown>,
): NotebookGenerationInputContract {
  const slots = inputSlots(schema);
  if (tool === "generate_kie_seedance_2_5_video") {
    return seedanceContract(tool, slots);
  }
  if (tool === "generate_kie_kling_3_0_omni_text_to_video") {
    return { modes: [mode("t2v", [])] };
  }
  if (tool === "generate_kie_kling_3_0_omni_image_to_video") {
    return {
      modes: [
        mode(
          "i2v",
          slotsByField(slots, ["image_refs"]),
          [["image_refs"]],
        ),
      ],
    };
  }
  if (tool === "generate_kie_kling_3_0_omni_reference_to_video") {
    return {
      modes: [
        mode(
          "r2v",
          slotsByField(slots, ["image_refs", "video_refs"]),
          [["image_refs", "video_refs"]],
        ),
      ],
    };
  }
  if (tool === "generate_kie_kling_3_0_omni_transformation") {
    return {
      modes: [
        mode(
          "transformation",
          slotsByField(slots, ["image_refs", "video_refs"]),
          [["video_refs"]],
        ),
      ],
    };
  }
  if (tool === "generate_kie_gemini_omni_video") {
    return kieOmniContract(slots);
  }
  if (tool === "generate_google_flow_omni_flash_video") {
    return googleOmniContract(slots);
  }
  if (
    tool === "generate_kie_wan_3_0_video"
    || tool === "generate_kie_wan_3_0_prime_video"
  ) {
    return wan30Contract(slots);
  }
  const modeId = getActionSpec(tool)?.operation === "reference_to_video" ? "r2v" : "default";
  return { modes: [mode(modeId, slots)] };
}

function cellInputKind(cell: NotebookCell): NotebookGenerationInputKind | null {
  if (
    cell.type === "image"
    || cell.type === "generate_image"
  ) return "image";
  if (
    cell.type === "video"
    || cell.type === "split_video"
    || cell.type === "generate_video"
    || cell.type === "concat"
    || cell.type === "splice"
  ) return "video";
  if (
    cell.type === "audio"
    || cell.type === "extract_audio"
    || cell.type === "generate_audio"
  ) return "audio";
  return null;
}

function connectedInputTarget(
  kind: NotebookGenerationInputKind,
  targetInput: string,
): string {
  if (targetInput === "first_frame" || targetInput === "last_frame") {
    return targetInput;
  }
  if (kind === "audio" && targetInput === "replace_audio") {
    return targetInput;
  }
  return kind;
}

function connectedInputs(
  document: NotebookDocument,
  cell: NotebookCell,
): ConnectedInput[] {
  const cells = new Map(document.cells.map((candidate) => [candidate.id, candidate]));
  return document.edges.flatMap((edge) => {
    if (edge.target !== cell.id) return [];
    const source = cells.get(edge.source);
    const kind = source ? cellInputKind(source) : null;
    return kind
      ? [{ kind, target: connectedInputTarget(kind, edge.targetInput) }]
      : [];
  });
}

export function notebookGenerationInputsAreCompatible(
  contract: NotebookGenerationInputContract,
  document: NotebookDocument,
  cell: NotebookCell,
  modeId?: string,
): boolean {
  const inputs = connectedInputs(document, cell);
  const configuredModes = modeId
    ? contract.modes.filter((candidate) => candidate.id === modeId)
    : contract.modes;
  const modes = modeId === "default" && configuredModes.length === 0
    ? contract.modes
    : configuredModes;
  return modes.some((candidate) => generationModeInputError(candidate, inputs) === null);
}

export function notebookGenerationInputError(
  contract: NotebookGenerationInputContract,
  document: NotebookDocument,
  cell: NotebookCell,
  modeId?: string,
): string | null {
  const candidate = contract.modes.find((mode) => mode.id === modeId)
    ?? (contract.modes.length === 1 ? contract.modes[0] : undefined);
  return candidate ? generationModeInputError(candidate, connectedInputs(document, cell)) : null;
}
