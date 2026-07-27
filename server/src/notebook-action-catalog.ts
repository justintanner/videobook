import type { NotebookCell, NotebookCellType, NotebookDocument } from "videobook-engine";
import {
  GENERATION_ACTIONS,
  getActionSpec,
  type GenerationActionSpec,
} from "./generation-registry.js";

function rawCellRows(notebookId: string, cell: NotebookCell) {
  return [
    { column: "notebook_id", type: "TEXT", value: notebookId },
    { column: "cell_id", type: "TEXT", value: cell.id },
    { column: "type", type: "TEXT", value: cell.type },
    { column: "slug", type: "TEXT", value: cell.slug },
    { column: "grid_row", type: "INTEGER", value: cell.slot.row },
    { column: "grid_column", type: "INTEGER", value: cell.slot.column },
    {
      column: "output_entity_id",
      type: "TEXT",
      value: cell.outputEntityId ?? null,
    },
    { column: "prompt", type: "TEXT", value: cell.prompt ?? null },
    { column: "provider", type: "TEXT", value: cell.provider ?? null },
    { column: "model", type: "TEXT", value: cell.model ?? null },
    { column: "operation", type: "TEXT", value: cell.operation ?? null },
    { column: "tool", type: "TEXT", value: cell.tool ?? null },
    {
      column: "inputs_json",
      type: "TEXT",
      value: JSON.stringify(cell.inputs ?? {}),
    },
    {
      column: "output_artifact_id",
      type: "TEXT",
      value: cell.outputArtifactId ?? null,
    },
  ] as const;
}

export type NotebookActionKind =
  | "local"
  | "analysis"
  | "generation"
  | "assembly";

export interface NotebookActionParameter {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "json";
  required: boolean;
  default?: string | number | boolean | null;
  enumValues?: string[];
  description: string;
}

export interface NotebookAction {
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
}

const LOCAL_ACTIONS: NotebookAction[] = [
  {
    id: "local.analyze_source",
    cellTypes: ["analyze"],
    kind: "analysis",
    operation: "analyze_source",
    provider: "kie",
    model: "gemini-3.5-flash",
    tool: "kie_gemini_analysis",
    title: "Analyze source",
    description: "Run KIE Gemini 3.5 Flash analysis and emit normalized shots",
    outputKind: "script",
    billable: true,
    defaults: {
      provider: "kie",
      model: "gemini-3.5-flash",
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
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
    id: "local.extract_audio",
    cellTypes: ["extract_audio"],
    kind: "local",
    operation: "extract_audio",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Extract audio",
    description: "Extract first-class playable audio from a source or scene split",
    outputKind: "artifact",
    billable: false,
    defaults: { operation: "extract_audio", tool: "ffmpeg", provider: "local" },
    parameters: [],
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
    model: "gpt-5.2",
    tool: "rewrite_prompt",
    title: "Write animation prompt",
    description: "Rewrite an animation prompt using scene analysis and endpoint frames",
    outputKind: "script",
    billable: true,
    defaults: {
      provider: "openai",
      model: "gpt-5.2",
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

const DEFAULT_ANIMATION_TOOL = "generate_kie_seedance_2_0_video";
const DEFAULT_IMAGE_TOOL = "generate_kie_gpt_image_2_text_to_image";
const DEFAULT_AUDIO_TOOL = "generate_elevenlabs_text_to_audio";

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
    title: spec.canonical_name,
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
  };
}

export function listNotebookActions(options: {
  includeHiddenGeneration?: boolean;
} = {}): NotebookAction[] {
  const generation = GENERATION_ACTIONS
    .filter((spec) =>
      options.includeHiddenGeneration
      || spec.picker_visibility === "visible"
      || spec.canonical_name === DEFAULT_ANIMATION_TOOL
      || spec.canonical_name === DEFAULT_AUDIO_TOOL)
    .flatMap((spec) => {
      const action = generationAction(spec);
      return action ? [action] : [];
    });
  return [...LOCAL_ACTIONS, ...generation]
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function actionsForCell(
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

export function defaultActionForCell(
  cell: NotebookCell,
  document: NotebookDocument,
): NotebookAction | null {
  const actions = actionsForCell(cell, document);
  const tool = cell.tool ?? cell.model;
  const configured = tool
    ? actions.find((action) =>
      action.tool === tool || action.id === tool || action.model === tool)
    : undefined;
  if (configured) return configured;
  if (cell.operation) {
    const operation = actions.find((action) => action.operation === cell.operation);
    if (operation) return operation;
  }
  if (cell.type === "analyze") {
    return actions.find((action) => action.operation === "analyze_source")
      ?? null;
  }
  if (cell.type === "split_video") {
    return actions.find((action) => action.operation === "split_range")
      ?? null;
  }
  if (cell.type === "extract_audio") {
    return actions.find((action) => action.operation === "extract_audio")
      ?? null;
  }
  if (cell.type === "concat") {
    return actions.find((action) => action.operation === "concat_video")
      ?? null;
  }
  if (cell.type === "splice") {
    return actions.find((action) => action.operation === "splice_video")
      ?? null;
  }
  const defaultGenerationTool = cell.type === "generate_video"
    ? DEFAULT_ANIMATION_TOOL
    : cell.type === "generate_image"
      ? DEFAULT_IMAGE_TOOL
      : cell.type === "generate_audio"
        ? DEFAULT_AUDIO_TOOL
        : null;
  if (defaultGenerationTool) {
    return actions.find((action) => action.tool === defaultGenerationTool)
      ?? null;
  }
  return null;
}

export function validateCellConfiguration(
  cell: NotebookCell,
  document: NotebookDocument,
): { ok: true; action: NotebookAction | null } | { ok: false; message: string } {
  const actions = actionsForCell(cell, document, { includeHiddenGeneration: true });
  const hasActionConfiguration = Boolean(
    cell.operation ?? cell.tool ?? cell.model,
  );
  if (!hasActionConfiguration) {
    return { ok: true, action: defaultActionForCell(cell, document) };
  }
  if (actions.length === 0) {
    return { ok: false, message: `No actions available for cell type ${cell.type}` };
  }
  const tool = cell.tool ?? cell.model;
  if (tool) {
    const registeredSpec = getActionSpec(tool);
    const registeredAction = registeredSpec
      ? generationAction(registeredSpec)
      : null;
    const match = actions.find((action) =>
      action.tool === tool || action.id === tool || action.model === tool)
      ?? registeredAction
      ?? undefined;
    if (!match || !match.cellTypes.includes(cell.type)) {
      return {
        ok: false,
        message: `Tool ${tool} is not valid for cell type ${cell.type}`,
      };
    }
    if (cell.provider && match.provider && cell.provider !== match.provider) {
      return {
        ok: false,
        message: `Provider ${cell.provider} is incompatible with tool ${tool}`,
      };
    }
    return { ok: true, action: match };
  }
  const match = actions.find((action) => action.operation === cell.operation);
  if (!match) {
    return {
      ok: false,
      message: `Operation ${cell.operation} is not valid for cell type ${cell.type}`,
    };
  }
  if (cell.provider && match.provider && cell.provider !== match.provider) {
    return {
      ok: false,
      message: `Provider ${cell.provider} is incompatible with operation ${cell.operation}`,
    };
  }
  return { ok: true, action: match };
}

export function normalizeCellActionFields(
  cell: NotebookCell,
  document: NotebookDocument,
): NotebookCell {
  const validated = validateCellConfiguration(cell, document);
  if (!validated.ok || !validated.action) return cell;
  const action = validated.action;
  return {
    ...cell,
    provider: cell.provider ?? action.provider ?? undefined,
    model: cell.model ?? action.model ?? undefined,
    operation: cell.operation ?? action.operation,
    tool: cell.tool ?? action.tool ?? undefined,
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
  const execution = {
    ...((document.properties?.execution
      && typeof document.properties.execution === "object"
      && !Array.isArray(document.properties.execution))
      ? document.properties.execution as Record<string, unknown>
      : {}),
  };
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
    properties: {
      ...(document.properties ?? {}),
      execution,
    },
  };
}

export function selectedCellDetails(
  notebookId: string,
  document: NotebookDocument,
  cellId: string,
): Record<string, unknown> {
  const cell = document.cells.find((candidate) => candidate.id === cellId);
  if (!cell) throw new Error(`Cell not found: ${cellId}`);
  const upstream = document.edges
    .filter((edge) => edge.target === cellId)
    .map((edge) => ({
      edgeId: edge.id,
      sourceCellId: edge.source,
      targetInput: edge.targetInput,
      source: document.cells.find((candidate) => candidate.id === edge.source) ?? null,
    }));
  const downstream = document.edges
    .filter((edge) => edge.source === cellId)
    .map((edge) => ({
      edgeId: edge.id,
      targetCellId: edge.target,
      targetInput: edge.targetInput,
      target: document.cells.find((candidate) => candidate.id === edge.target) ?? null,
    }));
  const executionRaw = document.properties?.execution;
  const execution = executionRaw
    && typeof executionRaw === "object"
    && !Array.isArray(executionRaw)
    ? (executionRaw as Record<string, unknown>)[cellId] ?? null
    : null;
  const action = defaultActionForCell(cell, document);
  const validation = validateCellConfiguration(cell, document);
  return {
    cell,
    rawRow: rawCellRows(notebookId, cell),
    action,
    availableActions: actionsForCell(cell, document),
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
    resolvedRequest: sanitizeResolvedRequest(cell, action),
  };
}

function sanitizeResolvedRequest(
  cell: NotebookCell,
  action: NotebookAction | null,
): Record<string, unknown> {
  return {
    type: cell.type,
    slug: cell.slug,
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

export function generationSpecOrNull(tool: string): GenerationActionSpec | null {
  return getActionSpec(tool) ?? null;
}

export { DEFAULT_ANIMATION_TOOL };
