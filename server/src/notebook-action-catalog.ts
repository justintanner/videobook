import type {
  Generation,
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from "videobook-engine";
import { notebookCellTableRows } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import {
  GENERATION_ACTIONS,
  getActionSpec,
  type GenerationActionSpec,
} from "./generation-registry.js";
import {
  ANALYSIS_REASONING_EFFORT,
  INTELLIGENCE_MODEL,
  INTELLIGENCE_REASONING_EFFORT,
  OPENAI_ANALYSIS_TOOL,
} from "./openai-intelligence.js";
import type { NotebookGenerationInputContract } from "./notebook-generation-contract.js";
import type { NotebookGenerationControl } from "./notebook-generation-controls.js";

type NotebookActionKind =
  | "local"
  | "analysis"
  | "generation"
  | "assembly";

interface NotebookActionParameter {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "json";
  required: boolean;
  default?: string | number | boolean | null;
  enumValues?: string[];
  description: string;
}

interface NotebookAction {
  id: string;
  cellTypes: NotebookCellType[];
  kind: NotebookActionKind;
  operation: string;
  provider: string | null;
  model: string | null;
  tool: string | null;
  title: string;
  description: string;
  outputKind: "artifact" | "script" | "sequence" | "none";
  billable: boolean;
  defaults: Record<string, unknown>;
  parameters: NotebookActionParameter[];
  requiredInputs: string[];
  capabilities: {
    dualFrame: boolean;
    localMedia: boolean;
    requiresConfirmation: boolean;
  };
  isDefault?: boolean;
  providerLabel?: string;
  defaultPriority?: number;
  inputContract?: NotebookGenerationInputContract;
  controls?: NotebookGenerationControl[];
}

const LOCAL_ACTIONS: NotebookAction[] = [
  {
    id: "local.analyze_source",
    cellTypes: ["analyze"],
    kind: "analysis",
    operation: "analyze_source",
    provider: "openai",
    model: INTELLIGENCE_MODEL,
    tool: OPENAI_ANALYSIS_TOOL,
    title: "Analyze source",
    description: "Run OpenAI Responses analysis and emit normalized shots",
    outputKind: "script",
    billable: true,
    defaults: {
      provider: "openai",
      model: INTELLIGENCE_MODEL,
      reasoning: { effort: ANALYSIS_REASONING_EFFORT },
      operation: "analyze_source",
      tool: OPENAI_ANALYSIS_TOOL,
    },
    parameters: [
      {
        name: "prompt",
        type: "string",
        required: true,
        description: "Editable analysis instructions stored on the cell",
      },
    ],
    requiredInputs: ["source"],
    capabilities: {
      dualFrame: false,
      localMedia: false,
      requiresConfirmation: false,
    },
  },
  {
    id: "local.split_at_points",
    cellTypes: ["split_video"],
    kind: "local",
    operation: "split_at_points",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Split video at points",
    description: "Split a complete source into ordered contiguous chunks",
    outputKind: "artifact",
    billable: false,
    defaults: { operation: "split_at_points", tool: "ffmpeg", provider: "local" },
    parameters: [
      {
        name: "cutPointsSeconds",
        type: "json",
        required: true,
        description: "Ordered cut points in source seconds",
      },
    ],
    requiredInputs: ["video"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
  {
    id: "local.split_ranges",
    cellTypes: ["split_video"],
    kind: "local",
    operation: "split_ranges",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Split video ranges",
    description: "Materialize keep, remove, or custom output range groups from a source",
    outputKind: "artifact",
    billable: false,
    defaults: { operation: "split_ranges", tool: "ffmpeg", provider: "local" },
    parameters: [
      {
        name: "outputsSeconds",
        type: "json",
        required: true,
        description: "Output range groups; each inner array is one cell, multiple ranges concat",
      },
    ],
    requiredInputs: ["video"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
  {
    id: "local.split_range",
    cellTypes: ["split_video"],
    kind: "local",
    operation: "split_range",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Split video",
    description: "Trim a continuous source range into a clip artifact",
    outputKind: "artifact",
    billable: false,
    defaults: { operation: "split_range", tool: "ffmpeg", provider: "local" },
    parameters: [
      {
        name: "startSeconds",
        type: "number",
        required: true,
        description: "Range start in source seconds",
      },
      {
        name: "endSeconds",
        type: "number",
        required: true,
        description: "Range end in source seconds",
      },
    ],
    requiredInputs: ["video"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },

  {
    id: "generation.rewrite_prompt",
    cellTypes: ["prompt"],
    kind: "generation",
    operation: "rewrite_prompt",
    provider: "openai",
    model: INTELLIGENCE_MODEL,
    tool: "rewrite_prompt",
    title: "Write animation prompt",
    description: "Rewrite an animation prompt using scene analysis and endpoint frames",
    outputKind: "script",
    billable: true,
    defaults: {
      provider: "openai",
      model: INTELLIGENCE_MODEL,
      reasoning: { effort: INTELLIGENCE_REASONING_EFFORT },
      operation: "rewrite_prompt",
      tool: "rewrite_prompt",
    },
    parameters: [
      {
        name: "prompt",
        type: "string",
        required: true,
        description: "Feature brief and scene direction to optimize for Seedance 2",
      },
    ],
    requiredInputs: ["analysis", "first_frame", "last_frame", "scene_audio"],
    capabilities: {
      dualFrame: true,
      localMedia: false,
      requiresConfirmation: true,
    },
  },
  {
    id: "local.concat_video",
    cellTypes: ["concat"],
    kind: "assembly",
    operation: "concat_video",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Concatenate videos",
    description: "Render two or more ordered clips into a playable H.264/AAC video",
    outputKind: "artifact",
    billable: false,
    defaults: {
      operation: "concat_video",
      tool: "ffmpeg",
      provider: "local",
    },
    parameters: [],
    requiredInputs: ["clip:0", "clip:1"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
  {
    id: "local.splice_video",
    cellTypes: ["splice"],
    kind: "assembly",
    operation: "splice_video",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Splice videos",
    description: "Join exactly two videos with an optional matching overlap window",
    outputKind: "artifact",
    billable: false,
    defaults: {
      operation: "splice_video",
      tool: "ffmpeg",
      provider: "local",
      overlap: 0,
    },
    parameters: [{
      name: "overlap",
      type: "number",
      required: false,
      default: 0,
      description: "Matching overlap window in seconds",
    }],
    requiredInputs: ["first", "second"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
  {
    id: "local.smooth_scene_concat",
    cellTypes: ["splice"],
    kind: "assembly",
    operation: "smooth_scene_concat",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Smooth scene splice",
    description: "Join exactly two videos with audio matching and a visual crossfade",
    outputKind: "artifact",
    billable: false,
    defaults: {
      operation: "smooth_scene_concat",
      tool: "ffmpeg",
      provider: "local",
    },
    parameters: [{
      name: "transitionSeconds",
      type: "number",
      required: false,
      default: null,
      description: "Fixed crossfade duration, or automatic audio alignment when omitted",
    }],
    requiredInputs: ["first", "second"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
];

const DEFAULT_ANIMATION_TOOL = "generate_kie_seedance_2_5_video";
const DEFAULT_VIDEO_TOOL = "generate_kie_gemini_omni_video";
const DEFAULT_IMAGE_TOOL = "generate_kie_nano_banana_pro_text_to_image";
const DEFAULT_AUDIO_TOOL = "generate_elevenlabs_text_to_audio";

const generationTitleOverrides: Record<string, string> = {
  generate_kie_gemini_omni_video: "Gemini Omni Video",
  generate_google_flow_omni_flash_video: "Gemini Omni Video",
  generate_kie_nano_banana_pro_text_to_image: "Nano Banana Pro",
  generate_google_flow_nano_banana_pro_image: "Nano Banana Pro",
  generate_kie_seedance_2_5_video: "Seedance 2.5",
  generate_kie_kling_3_0_omni_text_to_video: "Kling 3.0 Omni",
  generate_kie_kling_3_0_omni_image_to_video: "Kling 3.0 Omni Image",
  generate_kie_kling_3_0_omni_reference_to_video: "Kling 3.0 Omni Reference",
  generate_kie_kling_3_0_omni_transformation: "Kling 3.0 Omni Transformation",
  generate_kie_kling_3_0_motion_control: "Kling 3.0 Motion Control",
  generate_elevenlabs_text_to_audio: "ElevenLabs",
};

const providerLabels: Record<GenerationActionSpec["provider"], string> = {
  kie: "Kie",
  fal: "Fal",
  xai: "xAI",
  google_flow: "Google Flow",
  alibaba: "Alibaba",
  elevenlabs: "ElevenLabs",
  workflow: "Workflow",
};

function generationActionTitle(spec: GenerationActionSpec): string {
  const override = generationTitleOverrides[spec.canonical_name];
  if (override) return override;
  const withoutAction = spec.canonical_name.replace(
    /^(generate|extend|upscale)_/,
    "",
  );
  const withoutProvider = withoutAction.replace(
    /^(kie|fal|xai|google_flow|alibaba|elevenlabs|workflow)_/,
    "",
  );
  return withoutProvider
    .replace(/_(\d)_(\d)(?=_|$)/g, "_$1.$2")
    .split("_")
    .map((word) => {
      if (word === "gpt") return "GPT";
      if (word === "xai") return "xAI";
      if (word === "to") return "to";
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function generationDefaultPriority(tool: string): number | undefined {
  if (
    tool === DEFAULT_VIDEO_TOOL
    || tool === DEFAULT_IMAGE_TOOL
    || tool === DEFAULT_AUDIO_TOOL
  ) return 0;
  if (tool === DEFAULT_ANIMATION_TOOL) return 1;
  return undefined;
}

function generationCellType(
  spec: GenerationActionSpec,
): NotebookCellType | null {
  if (spec.media_type === "video") return "generate_video";
  if (spec.media_type === "image") return "generate_image";
  if (spec.media_type === "audio") return "generate_audio";
  return null;
}

function generationAction(spec: GenerationActionSpec): NotebookAction | null {
  const cellType = generationCellType(spec);
  if (!cellType) return null;
  return {
    id: `generation.${spec.canonical_name}`,
    cellTypes: [cellType],
    kind: "generation",
    operation: spec.operation,
    provider: spec.provider,
    model: spec.apicity_identifier,
    tool: spec.canonical_name,
    title: generationActionTitle(spec),
    description: `${spec.provider} ${spec.operation} (${spec.media_type})`,
    outputKind: "artifact",
    billable: true,
    defaults: {
      provider: spec.provider,
      model: spec.apicity_identifier,
      operation: spec.operation,
      tool: spec.canonical_name,
    },
    parameters: [],
    requiredInputs: [],
    capabilities: {
      dualFrame: spec.canonical_name.includes("seedance"),
      localMedia: false,
      requiresConfirmation: true,
    },
    providerLabel: providerLabels[spec.provider],
    defaultPriority: generationDefaultPriority(spec.canonical_name),
    isDefault:
      spec.canonical_name === DEFAULT_VIDEO_TOOL
      || spec.canonical_name === DEFAULT_IMAGE_TOOL
      || spec.canonical_name === DEFAULT_AUDIO_TOOL,
  };
}

export function listNotebookActions(options: {
  includeHiddenGeneration?: boolean;
} = {}): NotebookAction[] {
  const generation = GENERATION_ACTIONS
    .filter((spec) =>
      options.includeHiddenGeneration
      || spec.picker_visibility === "visible"
      || spec.canonical_name === DEFAULT_VIDEO_TOOL
      || spec.canonical_name === DEFAULT_ANIMATION_TOOL
      || spec.canonical_name === DEFAULT_IMAGE_TOOL
      || spec.canonical_name === DEFAULT_AUDIO_TOOL)
    .flatMap((spec) => {
      const action = generationAction(spec);
      return action ? [action] : [];
    });
  return [...LOCAL_ACTIONS, ...generation]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function actionsForCell(
  cell: NotebookCell,
  document: NotebookDocument,
  options: { includeHiddenGeneration?: boolean } = {},
): NotebookAction[] {
  const all = listNotebookActions(options).filter((action) =>
    action.cellTypes.includes(cell.type));
  if (cell.type !== "generate_video") return all;
  const inputs = new Set(
    document.edges
      .filter((edge) => edge.target === cell.id)
      .map((edge) => edge.targetInput),
  );
  const hasFrames = inputs.has("first_frame") && inputs.has("last_frame");
  return all.filter((action) => {
    if (action.kind !== "generation") return true;
    if (!action.capabilities.dualFrame) return !hasFrames || action.tool === cell.tool;
    return hasFrames || action.tool === DEFAULT_ANIMATION_TOOL || action.tool === cell.tool;
  });
}

function defaultActionForCell(
  cell: NotebookCell,
  document: NotebookDocument,
): NotebookAction | null {
  const normalizedCell = normalizeLegacyAnalyzeCell(cell);
  const actions = actionsForCell(normalizedCell, document);
  if (normalizedCell.type === "split_video" && normalizedCell.operation) {
    const splitOperation = actions.find((action) =>
      action.operation === normalizedCell.operation);
    if (splitOperation) return splitOperation;
  }
  const tool = normalizedCell.tool ?? normalizedCell.model;
  const configured = tool
    ? actions.find((action) =>
      action.tool === tool || action.id === tool || action.model === tool)
    : undefined;
  if (configured) return configured;
  if (normalizedCell.operation) {
    const operation = actions.find((action) =>
      action.operation === normalizedCell.operation);
    if (operation) return operation;
  }
  if (normalizedCell.type === "analyze") {
    return actions.find((action) => action.operation === "analyze_source")
      ?? null;
  }
  if (normalizedCell.type === "split_video") {
    return actions.find((action) => action.operation === "split_range")
      ?? null;
  }

  if (normalizedCell.type === "concat") {
    return actions.find((action) => action.operation === "concat_video")
      ?? null;
  }
  if (normalizedCell.type === "splice") {
    return actions.find((action) => action.operation === "splice_video")
      ?? null;
  }
  const defaultGenerationTools = normalizedCell.type === "generate_video"
    ? [DEFAULT_VIDEO_TOOL, DEFAULT_ANIMATION_TOOL]
    : normalizedCell.type === "generate_image"
      ? [DEFAULT_IMAGE_TOOL]
      : normalizedCell.type === "generate_audio"
        ? [DEFAULT_AUDIO_TOOL]
        : [];
  for (const tool of defaultGenerationTools) {
    const action = actions.find((candidate) => candidate.tool === tool);
    if (action) return action;
  }
  return null;
}

export function validateCellConfiguration(
  cell: NotebookCell,
  document: NotebookDocument,
): { ok: true; action: NotebookAction | null } | { ok: false; message: string } {
  const normalizedCell = normalizeLegacyAnalyzeCell(cell);
  const actions = actionsForCell(
    normalizedCell,
    document,
    { includeHiddenGeneration: true },
  );
  const hasActionConfiguration = Boolean(
    normalizedCell.operation ?? normalizedCell.tool ?? normalizedCell.model,
  );
  if (!hasActionConfiguration) {
    return {
      ok: true,
      action: defaultActionForCell(normalizedCell, document),
    };
  }
  if (actions.length === 0) {
    return {
      ok: false,
      message: `No actions available for cell type ${normalizedCell.type}`,
    };
  }
  const tool = normalizedCell.tool ?? normalizedCell.model;
  if (tool) {
    const registeredSpec = getActionSpec(tool);
    const registeredAction = registeredSpec
      ? generationAction(registeredSpec)
      : null;
    const match = actions.find((action) =>
      action.tool === tool || action.id === tool || action.model === tool)
      ?? registeredAction
      ?? undefined;
    if (!match || !match.cellTypes.includes(normalizedCell.type)) {
      return {
        ok: false,
        message: `Tool ${tool} is not valid for cell type ${normalizedCell.type}`,
      };
    }
    if (
      normalizedCell.provider
      && match.provider
      && normalizedCell.provider !== match.provider
    ) {
      return {
        ok: false,
        message:
          `Provider ${normalizedCell.provider} is incompatible with tool ${tool}`,
      };
    }
    return { ok: true, action: match };
  }
  const match = actions.find((action) =>
    action.operation === normalizedCell.operation);
  if (!match) {
    return {
      ok: false,
      message:
        `Operation ${normalizedCell.operation} is not valid for cell type ${normalizedCell.type}`,
    };
  }
  if (
    normalizedCell.provider
    && match.provider
    && normalizedCell.provider !== match.provider
  ) {
    return {
      ok: false,
      message:
        `Provider ${normalizedCell.provider} is incompatible with operation ${normalizedCell.operation}`,
    };
  }
  return { ok: true, action: match };
}

export function normalizeLegacyAnalyzeCell(cell: NotebookCell): NotebookCell {
  if (
    cell.type !== "analyze"
    || cell.provider !== "kie"
    || (
      cell.model !== "gemini-3.5-flash"
      && cell.model !== "gemini-3-5-flash"
    )
    || cell.tool !== "kie_gemini_analysis"
  ) {
    return cell;
  }
  return {
    ...cell,
    provider: "openai",
    model: INTELLIGENCE_MODEL,
    operation: "analyze_source",
    tool: OPENAI_ANALYSIS_TOOL,
  };
}

export function normalizeLegacyAnalyzeDocument(
  document: NotebookDocument,
): NotebookDocument {
  let changed = false;
  const cells = document.cells.map((cell) => {
    const normalized = normalizeLegacyAnalyzeCell(cell);
    if (normalized !== cell) changed = true;
    return normalized;
  });
  return changed ? { ...document, cells } : document;
}

export function normalizeCellActionFields(
  cell: NotebookCell,
  document: NotebookDocument,
): NotebookCell {
  const normalizedCell = normalizeLegacyAnalyzeCell(cell);
  const validated = validateCellConfiguration(normalizedCell, document);
  if (!validated.ok || !validated.action) return normalizedCell;
  const action = validated.action;
  return {
    ...normalizedCell,
    provider: normalizedCell.provider ?? action.provider ?? undefined,
    model: normalizedCell.model ?? action.model ?? undefined,
    operation: normalizedCell.operation ?? action.operation,
    tool: normalizedCell.tool ?? action.tool ?? undefined,
  };
}

export function markDescendantsStale(
  document: NotebookDocument,
  rootCellId: string,
): NotebookDocument {
  const children = new Map<string, string[]>();
  for (const edge of document.edges) {
    const list = children.get(edge.source) ?? [];
    list.push(edge.target);
    children.set(edge.source, list);
  }
  const stale = new Set<string>();
  const stack = [...(children.get(rootCellId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || stale.has(id)) continue;
    stale.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  if (stale.size === 0) return document;
  const execution = { ...(document.execution ?? {}) };
  for (const id of stale) {
    const current = execution[id];
    if (current && typeof current === "object" && !Array.isArray(current)) {
      execution[id] = {
        ...(current as Record<string, unknown>),
        stale: true,
      };
    } else {
      execution[id] = { stale: true };
    }
  }
  return {
    ...document,
    execution,
  };
}

export function selectedCellDetails(
  notebookId: string,
  document: NotebookDocument,
  cellId: string,
  generations: readonly Generation[] = [],
): Record<string, unknown> {
  const normalizedDocument = normalizeLegacyAnalyzeDocument(document);
  const cell = normalizedDocument.cells.find((candidate) =>
    candidate.id === cellId);
  if (!cell) throw new Error(`Cell not found: ${cellId}`);
  const upstream = normalizedDocument.edges
    .filter((edge) => edge.target === cellId)
    .map((edge) => ({
      edgeId: edge.id,
      sourceCellId: edge.source,
      targetInput: edge.targetInput,
      source: normalizedDocument.cells.find((candidate) =>
        candidate.id === edge.source) ?? null,
    }));
  const downstream = normalizedDocument.edges
    .filter((edge) => edge.source === cellId)
    .map((edge) => ({
      edgeId: edge.id,
      targetCellId: edge.target,
      targetInput: edge.targetInput,
      target: normalizedDocument.cells.find((candidate) =>
        candidate.id === edge.target) ?? null,
    }));
  const execution = normalizedDocument.execution?.[cellId] ?? null;
  const action = defaultActionForCell(cell, normalizedDocument);
  const validation = validateCellConfiguration(cell, normalizedDocument);
  const generationArtifactIds = generations.flatMap((row) => [
    ...(row.outputArtifactId ? [row.outputArtifactId] : []),
    ...(row.providerArtifactId ? [row.providerArtifactId] : []),
  ]);
  const uniqueGenerationArtifactIds = [...new Set(generationArtifactIds)];
  return {
    cell,
    rawRow: notebookCellTableRows(notebookId, cell),
    action,
    availableActions: actionsForCell(cell, normalizedDocument),
    validation,
    upstream,
    downstream,
    execution,
    params: cell.inputs ?? {},
    lineage: {
      references: cell.references ?? [],
      pinnedResults: cell.pinnedResults ?? [],
    },
    output: {
      artifactId: cell.outputArtifactId ?? null,
    },
    generations: {
      count: generations.length,
      latestStatus: generations[0]?.status ?? null,
      artifactIds: uniqueGenerationArtifactIds,
    },
    resolvedRequest: sanitizeResolvedRequest(cell, action),
  };
}

function sanitizeResolvedRequest(
  cell: NotebookCell,
  action: NotebookAction | null,
): Record<string, unknown> {
  return {
    type: cell.type,
    address: notebookGridTag(cell.slot),
    label: cell.label ?? null,
    prompt: cell.prompt ?? null,
    provider: cell.provider ?? action?.provider ?? null,
    model: cell.model ?? action?.model ?? null,
    operation: cell.operation ?? action?.operation ?? null,
    tool: cell.tool ?? action?.tool ?? null,
    parameters: Object.fromEntries(
      Object.entries(cell.inputs ?? {}).filter(([key]) =>
        !/(api[_-]?key|secret|token|password|authorization)/i.test(key)),
    ),
  };
}

export { DEFAULT_ANIMATION_TOOL, DEFAULT_IMAGE_TOOL, DEFAULT_VIDEO_TOOL };
