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
    { column: "title", type: "TEXT", value: cell.title },
    { column: "grid_row", type: "INTEGER", value: cell.slot.row },
    { column: "grid_column", type: "INTEGER", value: cell.slot.column },
    { column: "entity_id", type: "TEXT", value: cell.entityId ?? null },
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
  | "assembly"
  | "export";

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
    id: "local.preprocess_source",
    cellTypes: ["source"],
    kind: "local",
    operation: "preprocess_source",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Preprocess source",
    description: "Probe and prepare source media streams for downstream cells",
    outputKind: "artifact",
    billable: false,
    defaults: {},
    parameters: [],
    requiredInputs: [],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
  {
    id: "local.analyze_source",
    cellTypes: ["analysis"],
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
    cellTypes: ["split"],
    kind: "local",
    operation: "split_range",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Split source range",
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
    requiredInputs: ["source"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
  {
    id: "local.extract_audio",
    cellTypes: ["audio"],
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
    requiredInputs: ["source"],
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
    id: "local.capture_frame",
    cellTypes: ["frame"],
    kind: "local",
    operation: "capture_frame",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Capture frame",
    description: "Capture the first or last valid frame of a split",
    outputKind: "artifact",
    billable: false,
    defaults: { operation: "capture_frame", tool: "ffmpeg", provider: "local" },
    parameters: [
      {
        name: "frameRole",
        type: "enum",
        required: true,
        enumValues: ["first", "last"],
        description: "Whether to capture the first or last frame",
      },
    ],
    requiredInputs: ["segment"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
  {
    id: "local.assemble_sequence",
    cellTypes: ["sequence"],
    kind: "assembly",
    operation: "assemble_sequence",
    provider: "local",
    model: null,
    tool: "engine_sequence",
    title: "Assemble sequence",
    description: "Place ordered clips onto the canonical sequence with source audio",
    outputKind: "sequence",
    billable: false,
    defaults: {
      operation: "assemble_sequence",
      tool: "engine_sequence",
      provider: "local",
    },
    parameters: [],
    requiredInputs: ["clip", "audio"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
  {
    id: "local.export_master",
    cellTypes: ["export"],
    kind: "export",
    operation: "export_master",
    provider: "local",
    model: null,
    tool: "ffmpeg",
    title: "Export master",
    description: "Render a revision-pinned H.264/AAC master from the sequence",
    outputKind: "artifact",
    billable: false,
    defaults: { operation: "export_master", tool: "ffmpeg", provider: "local" },
    parameters: [],
    requiredInputs: ["sequence"],
    capabilities: {
      dualFrame: false,
      localMedia: true,
      requiresConfirmation: false,
    },
  },
];

const DEFAULT_ANIMATION_TOOL = "generate_kie_seedance_2_0_video";

function generationAction(spec: GenerationActionSpec): NotebookAction {
  return {
    id: `generation.${spec.canonical_name}`,
    cellTypes: spec.media_type === "image"
      ? ["image"]
      : spec.media_type === "video"
        ? ["video"]
        : ["audio"],
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
      || spec.canonical_name === DEFAULT_ANIMATION_TOOL)
    .map(generationAction);
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
  if (cell.type !== "video") return all;
  const inputs = new Set(
    document.edges
      .filter((edge) => edge.target === cell.id)
      .map((edge) => edge.targetInput),
  );
  const hasFrames = inputs.has("first_frame") && inputs.has("last_frame");
  return all.filter((action) => {
    if (!action.capabilities.dualFrame) return !hasFrames || action.tool === cell.tool;
    return hasFrames || action.tool === DEFAULT_ANIMATION_TOOL || action.tool === cell.tool;
  });
}

export function defaultActionForCell(
  cell: NotebookCell,
  document: NotebookDocument,
): NotebookAction | null {
  const actions = actionsForCell(cell, document);
  if (cell.type === "video") {
    return actions.find((action) => action.tool === DEFAULT_ANIMATION_TOOL)
      ?? actions[0]
      ?? null;
  }
  if (cell.type === "analysis") {
    return actions.find((action) => action.operation === "analyze_source")
      ?? actions[0]
      ?? null;
  }
  if (cell.type === "prompt") {
    return actions.find((action) => action.tool === "rewrite_prompt")
      ?? actions[0]
      ?? null;
  }
  return actions[0] ?? null;
}

export function validateCellConfiguration(
  cell: NotebookCell,
  document: NotebookDocument,
): { ok: true; action: NotebookAction | null } | { ok: false; message: string } {
  if (cell.type === "label" || cell.type === "note" || cell.type === "search"
    || cell.type === "selects" || cell.type === "character" || cell.type === "scene"
    || cell.type === "asset" || cell.type === "transcript" || cell.type === "source") {
    return { ok: true, action: defaultActionForCell(cell, document) };
  }
  const actions = actionsForCell(cell, document, { includeHiddenGeneration: true });
  if (actions.length === 0) {
    return { ok: false, message: `No actions available for cell type ${cell.type}` };
  }
  const tool = cell.tool ?? cell.model;
  if (tool) {
    const match = actions.find((action) =>
      action.tool === tool || action.id === tool || action.model === tool)
      ?? (getActionSpec(tool)
        ? generationAction(getActionSpec(tool)!)
        : undefined);
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
  return { ok: true, action: defaultActionForCell(cell, document) };
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
    title: cell.title,
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
