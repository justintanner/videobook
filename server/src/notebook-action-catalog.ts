import { LIGHTNING_SCENE_MODEL, LIGHTNING_VIDEO_MODEL } from "./lightning-defaults.js";
import type {
  Generation,
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from "videobook-engine";
import { notebookCellTableRows } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { listModels } from "./media/listing.js";
import type { ResolvedModel } from "./media/types.js";
import { notebookGenerationInputContract } from "./notebook-generation-contract.js";
import { controlsForModel } from "./notebook-generation-controls.js";
import {
  ANALYSIS_REASONING_EFFORT,
  INTELLIGENCE_MODEL,
  INTELLIGENCE_REASONING_EFFORT,
  OPENAI_ANALYSIS_TOOL,
} from "./openai-intelligence.js";
import type { NotebookGenerationInputContract } from "./notebook-generation-contract.js";
import type { NotebookGenerationControl } from "./notebook-generation-controls.js";
import { IMAGE_EDIT_MODELS } from "./image-edit-models.js";

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
  existingCellOnly?: boolean;
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

const DEFAULT_ANIMATION_MODEL = LIGHTNING_VIDEO_MODEL;
const DEFAULT_VIDEO_MODEL = LIGHTNING_VIDEO_MODEL;
const DEFAULT_IMAGE_MODEL = LIGHTNING_SCENE_MODEL;
const DEFAULT_AUDIO_MODEL = "elevenlabs:text-to-speech";
const DEFAULT_MODELS = new Set([DEFAULT_VIDEO_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_AUDIO_MODEL]);

const providerLabels: Record<ResolvedModel["provider"], string> = {
  kie: "Kie",
  fal: "Fal",
  xai: "xAI",
  alibaba: "Alibaba",
  elevenlabs: "ElevenLabs",
};

function hasDualFrame(model: ResolvedModel): boolean {
  const roles = new Set(model.slots.map((slot) => slot.role));
  return roles.has("first_frame") && roles.has("last_frame");
}

function generationAction(model: ResolvedModel): NotebookAction {
  const operation = model.entry.operations[0]!;
  const tool = `generate_${model.media}`;
  return {
    id: `generation.${model.id}`,
    cellTypes: [`generate_${model.media}`],
    kind: "generation",
    operation,
    provider: model.provider,
    model: model.id,
    tool,
    title: model.title,
    description: model.entry.description ?? `${providerLabels[model.provider]} ${model.entry.operations.join(", ")}`,
    outputKind: "artifact",
    billable: true,
    defaults: { provider: model.provider, model: model.id, operation, tool },
    parameters: [],
    requiredInputs: [],
    capabilities: {
      dualFrame: hasDualFrame(model),
      localMedia: false,
      requiresConfirmation: true,
    },
    providerLabel: providerLabels[model.provider],
    ...(DEFAULT_MODELS.has(model.id) ? { defaultPriority: 0, isDefault: true } : {}),
    inputContract: notebookGenerationInputContract(model),
    controls: controlsForModel(model),
  };
}

export function listNotebookActions(options: {
  includeHiddenGeneration?: boolean;
} = {}): NotebookAction[] {
  const generation = listModels({ includeHidden: options.includeHiddenGeneration === true })
    .map(generationAction);
  const imageEdits: NotebookAction[] = [
    ...IMAGE_EDIT_MODELS,
    { id: "sharp/layer-composite", label: "Remove subjects", provider: "local" as const },
  ].map((model) => ({
    id: `image-edit.${model.id}`,
    cellTypes: ["generate_image"],
    kind: "generation",
    operation: "image_to_image",
    provider: model.provider,
    providerLabel: model.provider === "local" ? "Local" : providerLabels[model.provider],
    model: model.id,
    tool: "edit_image_subjects",
    title: model.label,
    description: "Repeat an existing image edit with its saved subjects and regions",
    outputKind: "artifact",
    billable: model.provider !== "local",
    defaults: {},
    parameters: [],
    requiredInputs: ["image"],
    capabilities: { dualFrame: false, localMedia: true, requiresConfirmation: model.provider !== "local" },
    existingCellOnly: true,
    controls: [],
    inputContract: {
      modes: (model.provider === "local"
        ? ["subject-remove"]
        : ["whole-image", "subject-edit", "region-edit", "region-remove", "region-replace"]
      ).map((id) => ({
        id,
        slots: [{ field: "artifact_id", kind: "image", targets: ["image"], min: 1, max: 1 }],
        requiredGroups: [],
      })),
    },
  }));
  return [...LOCAL_ACTIONS, ...generation, ...imageEdits]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function configuredAction(
  actions: readonly NotebookAction[],
  cell: NotebookCell,
): NotebookAction | undefined {
  if (cell.model) {
    const byModel = actions.find((action) => action.model === cell.model
      && (!cell.tool || action.tool === cell.tool));
    if (byModel) return byModel;
  }
  const tool = cell.tool;
  if (!tool) return undefined;
  return actions.find((action) => action.kind !== "generation"
    && (action.tool === tool || action.id === tool));
}

function actionsForCell(
  cell: NotebookCell,
  document: NotebookDocument,
  options: { includeHiddenGeneration?: boolean } = {},
): NotebookAction[] {
  const all = listNotebookActions(options).filter((action) =>
    action.cellTypes.includes(cell.type)
    && (!action.existingCellOnly || cell.tool === action.tool));
  if (cell.type !== "generate_video") return all;
  const inputs = new Set(
    document.edges
      .filter((edge) => edge.target === cell.id)
      .map((edge) => edge.targetInput),
  );
  const hasFrames = inputs.has("first_frame") && inputs.has("last_frame");
  return all.filter((action) => {
    if (action.kind !== "generation") return true;
    if (!action.capabilities.dualFrame) return !hasFrames || action.model === cell.model;
    return hasFrames || action.model === DEFAULT_ANIMATION_MODEL || action.model === cell.model;
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
  const configured = configuredAction(actions, normalizedCell);
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
  const defaultModel = normalizedCell.type === "generate_video"
    ? DEFAULT_VIDEO_MODEL
    : normalizedCell.type === "generate_image"
      ? DEFAULT_IMAGE_MODEL
      : normalizedCell.type === "generate_audio"
        ? DEFAULT_AUDIO_MODEL
        : null;
  return actions.find((candidate) => candidate.model === defaultModel) ?? null;
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
    const match = configuredAction(actions, normalizedCell);
    if (!match || !match.cellTypes.includes(normalizedCell.type)) {
      return {
        ok: false,
        message: normalizedCell.model
          ? `Model ${normalizedCell.model} is not available for ${normalizedCell.type} cells; pick a model from list_generation_models`
          : `Tool ${tool} is not valid for cell type ${normalizedCell.type}`,
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
  const validation = validateCellConfiguration(cell, normalizedDocument);
  const action = validation.ok ? validation.action : null;
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

export { DEFAULT_ANIMATION_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL };
