import { createHash } from "node:crypto";
import { z } from "zod";
import type { ZodRawShape } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import {
  findAudioFile,
  findVideoFile,
} from "videobook-engine";
import {
  notebookGridAddress,
  parseNotebookGridAddress,
} from "videobook-engine/notebook-grid";
import {
  NOTEBOOK_GRID_ADDRESS_SOURCE,
  normalizeNotebookReference,
} from "videobook-engine/notebook-mentions";
import { resolveNotebookArtifactReference } from "./notebook-reference-resolver.js";
import { toolSpendsMoney } from "./paid-tools.js";

const CHAIN_VERSION = 1;
const CHAIN_MIN_STEPS = 1;
const CHAIN_MAX_STEPS = 16;
const CHAIN_UNSUPPORTED_TOOLS = new Set(["chain", "chat"]);

type ChainOutputType = "artifact" | "string" | "number" | "boolean" | "json";

type ChainCompletionKind =
  | "sync"
  | "extract_audio"
  | "replace_video_audio"
  | "trim_video"
  | "extract_frame"
  | "generation";

/** Which producer/output cell pair the executor builds for a chained generation. */
export type ChainPlacementKind = "generate_video" | "generate_image";

export type ChainToolSpec = {
  outputs: Record<string, ChainOutputType>;
  completion: ChainCompletionKind;
  gridFields: readonly string[];
  inputTypes: Record<string, ChainOutputType>;
  /** Present only for generation tools, whose artifacts need placing on the grid. */
  placement?: ChainPlacementKind;
  /** Output key carrying the artifact the generation produced. */
  artifactOutput?: string;
};

export const CHAIN_TOOL_CATALOG: Readonly<Record<string, ChainToolSpec>> = {
  generate_kie_nano_banana_2_1_image: {
    outputs: { img_asset_id: "artifact", asset_id: "artifact", cell_id: "string", address: "string", job_id: "string", status: "string" },
    completion: "generation", gridFields: ["image_refs"],
    inputTypes: { prompt: "string", image_refs: "artifact", aspect_ratio: "string", resolution: "string", output_format: "string" },
    placement: "generate_image", artifactOutput: "img_asset_id",
  },
  ...Object.fromEntries(["sunburst", "flare"].map(variant => [
    `generate_kie_gpt_image_2_5_${variant}_image`,
    {
      outputs: { img_asset_id: "artifact", asset_id: "artifact", cell_id: "string", address: "string", job_id: "string", status: "string" },
      completion: "generation",
      gridFields: ["image_refs"],
      inputTypes: { prompt: "string", image_refs: "artifact", aspect_ratio: "string", resolution: "string", background: "string" },
      placement: "generate_image",
      artifactOutput: "img_asset_id",
    } satisfies ChainToolSpec,
  ])),
  assemble_goal: {
    outputs: { sequence_id: "string", status: "string" },
    completion: "sync",
    gridFields: ["artifact_ids"],
    inputTypes: { goal_id: "string", artifact_ids: "artifact" },
  },
  extract_audio: {
    outputs: {
      audio_asset_id: "artifact",
      source_video: "artifact",
      job_id: "string",
      status: "string",
    },
    completion: "extract_audio",
    gridFields: ["asset_id"],
    inputTypes: { asset_id: "artifact" },
  },
  replace_video_audio: {
    outputs: {
      asset_id: "artifact",
      audio_asset_id: "artifact",
      job_id: "string",
      status: "string",
    },
    completion: "replace_video_audio",
    gridFields: ["asset_id", "audio_asset_id"],
    inputTypes: {
      asset_id: "artifact",
      audio_asset_id: "artifact",
    },
  },
  trim_video: {
    outputs: {
      asset_id: "artifact",
      job_id: "string",
      status: "string",
    },
    completion: "trim_video",
    gridFields: ["asset_id"],
    inputTypes: { asset_id: "artifact" },
  },
  extract_first_frame: {
    outputs: {
      image_asset_id: "artifact",
      source_video: "artifact",
      job_id: "string",
      status: "string",
    },
    completion: "extract_frame",
    gridFields: ["asset_id"],
    inputTypes: { asset_id: "artifact" },
  },
  extract_last_frame: {
    outputs: {
      image_asset_id: "artifact",
      source_video: "artifact",
      job_id: "string",
      status: "string",
    },
    completion: "extract_frame",
    gridFields: ["asset_id"],
    inputTypes: { asset_id: "artifact" },
  },
  extract_frame: {
    outputs: {
      image_asset_id: "artifact",
      source_video: "artifact",
      job_id: "string",
      status: "string",
    },
    completion: "extract_frame",
    gridFields: ["asset_id"],
    inputTypes: { asset_id: "artifact", timestamp: "number" },
  },
  asset_manifest: {
    outputs: {
      artifactId: "artifact",
      path: "string",
      files: "json",
    },
    completion: "sync",
    gridFields: ["asset_id"],
    inputTypes: { asset_id: "artifact" },
  },
  read_asset_metadata: {
    outputs: {
      value: "json",
    },
    completion: "sync",
    gridFields: ["asset_id"],
    inputTypes: { asset_id: "artifact", name: "string" },
  },
  generate_kie_seedance_2_5_video: {
    outputs: {
      vid_asset_id: "artifact",
      asset_id: "artifact",
      cell_id: "string",
      address: "string",
      job_id: "string",
      status: "string",
    },
    completion: "generation",
    gridFields: [
      "first_frame_ref",
      "last_frame_ref",
      "image_refs",
      "video_refs",
      "audio_refs",
      "replace_audio_with",
    ],
    inputTypes: {
      prompt: "string",
      first_frame_ref: "artifact",
      last_frame_ref: "artifact",
      image_refs: "artifact",
      video_refs: "artifact",
      audio_refs: "artifact",
      replace_audio_with: "artifact",
      duration: "string",
      resolution: "string",
      aspect_ratio: "string",
      output_format: "string",
    },
    placement: "generate_video",
    artifactOutput: "vid_asset_id",
  },
  generate_kie_nano_banana_pro_text_to_image: {
    outputs: {
      img_asset_id: "artifact",
      asset_id: "artifact",
      cell_id: "string",
      address: "string",
      job_id: "string",
      status: "string",
    },
    completion: "generation",
    gridFields: ["image_refs"],
    inputTypes: {
      prompt: "string",
      image_refs: "artifact",
      aspect_ratio: "string",
      resolution: "string",
      output_format: "string",
    },
    placement: "generate_image",
    artifactOutput: "img_asset_id",
  },
};

type ChainRef = {
  $ref: {
    step_id: string;
    output: string;
  };
};

export type ChainStep = {
  id: string;
  tool: string;
  params: Record<string, unknown>;
};

export type PinnedChainTarget = {
  field: string;
  /** Element position for array-valued fields; null for a plain string field. */
  index: number | null;
  address: string;
  cellId: string | null;
  artifactId: string;
  objectHash: string | null;
};

export type ChainPreflightStep = {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  spec: ChainToolSpec;
  pins: PinnedChainTarget[];
  autoApply: boolean;
  effect: "read" | "mutation" | "generation";
  /** This step spends provider money, so it stops for its own review. */
  requiresApproval: boolean;
};

export type ChainPreflightPlan = {
  version: typeof CHAIN_VERSION;
  bookId: string;
  notebookId: string | null;
  requestId: string | null;
  steps: ChainPreflightStep[];
  fingerprint: string;
  autoApply: boolean;
  effect: "read" | "mutation" | "generation";
};

export type ChainPreflightContext = {
  engine: Engine;
  bookId: string;
  notebookId?: string;
  toolSchemas: ReadonlyMap<string, ZodRawShape>;
  autoApplyTools: ReadonlySet<string>;
  effectForTool: (name: string) => "read" | "mutation" | "generation";
};

type ChainPreflightSuccess = {
  ok: true;
  plan: ChainPreflightPlan;
};

type ChainPreflightFailure = {
  ok: false;
  error: string;
};

type ChainPreflightResult = ChainPreflightSuccess | ChainPreflightFailure;

const GRID_TOKEN = NOTEBOOK_GRID_ADDRESS_SOURCE;
const GRID_PATTERN = new RegExp(`^@?(${GRID_TOKEN})$`, "iu");
const PLACEHOLDER_ARTIFACT = "01900000-0000-7000-8000-000000000001";

const chainRefSchema = z.object({
  $ref: z.object({
    step_id: z.string().min(1),
    output: z.string().min(1),
  }),
});

export const chainStepSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  tool: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
});

const chainRunInputSchema = z.object({
  action: z.literal("run"),
  version: z.literal(CHAIN_VERSION),
  book_id: z.string().uuid(),
  notebook_id: z.string().uuid().optional(),
  request_id: z.string().min(1).optional(),
  steps: z.array(chainStepSchema).min(CHAIN_MIN_STEPS).max(CHAIN_MAX_STEPS),
});

export const chainStatusInputSchema = z.object({
  action: z.literal("status"),
  book_id: z.string().uuid(),
  chain_id: z.string().uuid(),
});

export const chainCancelInputSchema = z.object({
  action: z.literal("cancel"),
  book_id: z.string().uuid(),
  chain_id: z.string().uuid(),
});

export const chainApproveInputSchema = z.object({
  action: z.literal("approve"),
  book_id: z.string().uuid(),
  chain_id: z.string().uuid(),
  step_id: z.string().min(1).max(64),
  actor: z.enum(["chat", "voice", "api"]).optional(),
});

export function isChainRef(value: unknown): value is ChainRef {
  return chainRefSchema.safeParse(value).success;
}

export function supportedChainTool(name: string): ChainToolSpec | null {
  if (CHAIN_UNSUPPORTED_TOOLS.has(name)) return null;
  return CHAIN_TOOL_CATALOG[name] ?? null;
}

export function chainPlanFingerprint(input: {
  version: number;
  notebookId?: string | null;
  steps: ChainStep[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: input.version,
      notebookId: input.notebookId ?? null,
      steps: input.steps,
    }))
    .digest("hex");
}

function typesCompatible(output: ChainOutputType, input: ChainOutputType): boolean {
  if (output === input) return true;
  return output === "artifact" && input === "string";
}

function walkValues(
  value: unknown,
  visit: (node: unknown, path: string) => void,
  path = "",
): void {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkValues(entry, visit, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object" && !isChainRef(value)) {
    for (const [key, child] of Object.entries(value)) {
      walkValues(child, visit, path ? `${path}.${key}` : key);
    }
  }
}

const CHAIN_STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function chainStepRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function chainStepId(value: unknown): string | null {
  return typeof value === "string" && CHAIN_STEP_ID.test(value) ? value : null;
}

function unusedChainStepId(
  preferred: Array<string | null>,
  used: ReadonlySet<string>,
  index: number,
): string {
  for (const candidate of preferred) {
    if (candidate && !used.has(candidate)) return candidate;
  }
  let number = index + 1;
  while (used.has(`step${number}`)) number += 1;
  return `step${number}`;
}

function chainStepIndexAlias(token: string, count: number): number | null {
  const numbered = /^(?:step[_-]?)?(\d+)$/iu.exec(token);
  if (!numbered) return null;
  const number = Number(numbered[1]);
  if (token === "0") return count > 0 ? 0 : null;
  if (number >= 1 && number <= count) return number - 1;
  return null;
}

export function ensureChainStepIds(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps;
  const records = steps.map(chainStepRecord);
  const explicit = records.map((record) => chainStepId(record?.id));
  const used = new Set(explicit.filter((id): id is string => id !== null));
  const toolCounts = new Map<string, number>();
  for (const record of records) {
    const tool = typeof record?.tool === "string" ? record.tool : "";
    if (!tool) continue;
    toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
  }
  const ids = records.map((record, index) => {
    if (!record) return null;
    const current = explicit[index];
    if (current) return current;
    const tool = typeof record.tool === "string" ? record.tool : "";
    const toolId = toolCounts.get(tool) === 1 ? chainStepId(tool) : null;
    const alias = chainStepId(record.step_id) ?? chainStepId(record.name);
    const id = unusedChainStepId([alias, toolId], used, index);
    used.add(id);
    return id;
  });
  const idSet = new Set(ids.filter((id): id is string => id !== null));
  const toolIds = new Map<string, string>();
  records.forEach((record, index) => {
    const tool = typeof record?.tool === "string" ? record.tool : "";
    const id = ids[index];
    if (!tool || !id || toolCounts.get(tool) !== 1) return;
    toolIds.set(tool, id);
  });
  const resolveRef = (token: string): string => {
    if (idSet.has(token)) return token;
    const fromTool = toolIds.get(token);
    if (fromTool) return fromTool;
    const index = chainStepIndexAlias(token, ids.length);
    return index === null ? token : ids[index] ?? token;
  };
  let refsChanged = false;
  const next = steps.map((entry, index) => {
    const record = records[index];
    const id = ids[index];
    if (!record || !id) return entry;
    const params = chainStepRecord(record.params);
    const nextParams = params
      ? mapChainParams(params, (node) => {
        if (!isChainRef(node)) return node;
        const stepId = resolveRef(node.$ref.step_id);
        if (stepId === node.$ref.step_id) return node;
        refsChanged = true;
        return { $ref: { step_id: stepId, output: node.$ref.output } };
      }) as Record<string, unknown>
      : record.params;
    if (record.id === id && !refsChanged) return entry;
    return { ...record, id, params: nextParams };
  });
  const unchanged = !refsChanged && next.every((entry, index) => entry === steps[index]);
  return unchanged ? steps : next;
}

function chainInputWithStepIds(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, "steps")) return input;
  const steps = ensureChainStepIds(record.steps);
  return steps === record.steps ? input : { ...record, steps };
}

function mapChainParams(
  value: unknown,
  map: (node: unknown, path: string) => unknown,
  path = "",
): unknown {
  const mapped = map(value, path);
  if (mapped !== value) return mapped;
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      mapChainParams(entry, map, `${path}[${index}]`));
  }
  if (value && typeof value === "object" && !isChainRef(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      next[key] = mapChainParams(child, map, path ? `${path}.${key}` : key);
    }
    return next;
  }
  return value;
}

export function substituteChainRefs(
  params: Record<string, unknown>,
  outputs: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
  return mapChainParams(params, (node) => {
    if (!isChainRef(node)) return node;
    const stepOutputs = outputs.get(node.$ref.step_id);
    if (!stepOutputs || !(node.$ref.output in stepOutputs)) {
      throw new Error(
        `Missing output ${node.$ref.output} from step ${node.$ref.step_id}`,
      );
    }
    return stepOutputs[node.$ref.output];
  }) as Record<string, unknown>;
}

function looksLikeGridAttempt(value: string): boolean {
  return value.startsWith("@") || GRID_PATTERN.test(value.trim());
}

function asGridAddress(value: string): string | null {
  const slot = parseNotebookGridAddress(normalizeNotebookReference(value));
  return slot ? notebookGridAddress(slot) : null;
}

async function primaryObjectHash(
  engine: Engine,
  artifactId: string,
): Promise<string | null> {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok) return null;
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) return null;
  const file = findVideoFile(manifest.value.files)
    ?? findAudioFile(manifest.value.files, artifact.value.kind)
    ?? manifest.value.files.find((entry) => entry.name.startsWith("original."))
    ?? manifest.value.files[0];
  return file?.objectHash ?? null;
}

async function resolvePinnedTarget(
  context: ChainPreflightContext,
  field: string,
  index: number | null,
  raw: string,
): Promise<PinnedChainTarget | string> {
  const notebookId = context.notebookId;
  let notebook: NotebookDocument | null = null;
  if (notebookId) {
    const read = context.engine.notebooks.read(notebookId);
    if (!read.ok) return read.error.message;
    notebook = read.value;
  }
  const documents = notebook
    ? [notebook]
    : context.engine.notebooks.list();
  const resolved = resolveNotebookArtifactReference({
    engine: context.engine,
    documents,
    reference: raw,
    requireMedia: false,
  });
  if ("code" in resolved) {
    return resolved.message;
  }
  const objectHash = await primaryObjectHash(context.engine, resolved.artifactId);
  return {
    field,
    index,
    address: resolved.cellAddress ?? normalizeNotebookReference(raw),
    cellId: resolved.cellId ?? null,
    artifactId: resolved.artifactId,
    objectHash,
  };
}

/**
 * Resolve one grid-addressable value to a pin, or report why it cannot be one.
 * Anything that is neither an address attempt nor an id is left alone for the
 * tool's own schema to judge.
 */
async function pinGridField(
  context: ChainPreflightContext,
  stepId: string,
  field: string,
  index: number | null,
  raw: string,
): Promise<PinnedChainTarget | string | null> {
  if (looksLikeGridAttempt(raw) && !asGridAddress(raw) && !raw.includes("-")) {
    return `Step ${stepId} field ${field} is not a valid @a1-@bl8 target`;
  }
  if (!looksLikeGridAttempt(raw) && !raw.includes("-")) return null;
  const pinned = await resolvePinnedTarget(context, field, index, raw);
  return typeof pinned === "string" ? `Step ${stepId} ${pinned}` : pinned;
}

function collectRefs(params: Record<string, unknown>): Array<{
  path: string;
  ref: ChainRef;
  field: string;
}> {
  const refs: Array<{ path: string; ref: ChainRef; field: string }> = [];
  walkValues(params, (node, path) => {
    if (!isChainRef(node)) return;
    const field = path.split("[")[0]!.split(".").pop() ?? path;
    refs.push({ path, ref: node, field });
  });
  return refs;
}

function withRefPlaceholders(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return mapChainParams(params, (node) => {
    if (!isChainRef(node)) return node;
    return PLACEHOLDER_ARTIFACT;
  }) as Record<string, unknown>;
}

export async function preflightChainPlan(
  input: unknown,
  context: ChainPreflightContext,
): Promise<ChainPreflightResult> {
  if (
    typeof input === "object"
    && input !== null
    && "action" in input
    && (input as { action?: unknown }).action !== undefined
    && (input as { action?: unknown }).action !== "run"
  ) {
    return { ok: false, error: "Chain preflight only accepts action=run" };
  }
  const parsed = chainRunInputSchema.safeParse(chainInputWithStepIds(input));
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  const data = parsed.data;
  if (data.book_id !== context.bookId) {
    return { ok: false, error: "Chain book_id does not match the active book" };
  }
  if (data.notebook_id && context.notebookId && data.notebook_id !== context.notebookId) {
    return {
      ok: false,
      error: "Chain notebook_id does not match the active notebook",
    };
  }
  const notebookId = data.notebook_id ?? context.notebookId ?? null;
  const ids = data.steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "Chain step ids must be unique" };
  }

  const declared = new Map<string, { index: number; spec: ChainToolSpec }>();
  const preflightSteps: ChainPreflightStep[] = [];

  for (const [index, step] of data.steps.entries()) {
    if (CHAIN_UNSUPPORTED_TOOLS.has(step.tool)) {
      return {
        ok: false,
        error: `Unsupported chain tool: ${step.tool}`,
      };
    }
    const spec = supportedChainTool(step.tool);
    if (!spec) {
      return {
        ok: false,
        error: `Unknown or unsupported chain tool: ${step.tool}`,
      };
    }
    const schema = context.toolSchemas.get(step.tool);
    if (!schema) {
      return { ok: false, error: `Unknown or unsupported chain tool: ${step.tool}` };
    }
    if (typeof step.params.book_id === "string" && step.params.book_id !== context.bookId) {
      return {
        ok: false,
        error: `Step ${step.id} overrides book_id and cannot dispatch cross-book`,
      };
    }
    if (
      typeof step.params.notebook_id === "string"
      && notebookId
      && step.params.notebook_id !== notebookId
    ) {
      return {
        ok: false,
        error: `Step ${step.id} overrides notebook_id and cannot dispatch cross-notebook`,
      };
    }

    const refs = collectRefs(step.params);
    for (const { ref, field, path } of refs) {
      if (ref.$ref.step_id === step.id) {
        return {
          ok: false,
          error: `Step ${step.id} cannot reference its own output at ${path}`,
        };
      }
      const earlier = declared.get(ref.$ref.step_id);
      if (!earlier) {
        const later = data.steps.some((candidate) => candidate.id === ref.$ref.step_id);
        return {
          ok: false,
          error: later
            ? `Step ${step.id} has a forward reference to ${ref.$ref.step_id} at ${path}`
            : `Step ${step.id} references unknown step ${ref.$ref.step_id} at ${path}`,
        };
      }
      if (earlier.index >= index) {
        return {
          ok: false,
          error: `Step ${step.id} has a forward reference to ${ref.$ref.step_id} at ${path}`,
        };
      }
      const outputType = earlier.spec.outputs[ref.$ref.output];
      if (!outputType) {
        return {
          ok: false,
          error: `Step ${step.id} references unavailable output ${ref.$ref.step_id}.${ref.$ref.output}`,
        };
      }
      const inputType = spec.inputTypes[field] ?? "string";
      if (!typesCompatible(outputType, inputType)) {
        return {
          ok: false,
          error: `Step ${step.id} input ${field} is incompatible with ${ref.$ref.step_id}.${ref.$ref.output}`,
        };
      }
    }

    const pins: PinnedChainTarget[] = [];
    for (const field of spec.gridFields) {
      const raw = step.params[field];
      if (isChainRef(raw) || raw === undefined) continue;
      const entries: Array<{ index: number | null; value: unknown }> = Array.isArray(raw)
        ? raw.map((value, position) => ({ index: position, value }))
        : [{ index: null, value: raw }];
      for (const entry of entries) {
        if (isChainRef(entry.value)) continue;
        if (typeof entry.value !== "string") {
          return {
            ok: false,
            error: `Step ${step.id} field ${field} must be a string or {$ref}`,
          };
        }
        const pinned = await pinGridField(context, step.id, field, entry.index, entry.value);
        if (typeof pinned === "string") return { ok: false, error: pinned };
        if (pinned) pins.push(pinned);
      }
    }

    const literalParams = withRefPlaceholders(step.params);
    const validated = z.object(schema).safeParse({
      ...literalParams,
      book_id: context.bookId,
      ...(notebookId && schema.notebook_id !== undefined
        ? { notebook_id: notebookId }
        : {}),
    });
    if (!validated.success) {
      return {
        ok: false,
        error: `Invalid parameters for ${step.tool}: ${z.prettifyError(validated.error)}`,
      };
    }

    declared.set(step.id, { index, spec });
    const effect = context.effectForTool(step.tool);
    const autoApplyStep = context.autoApplyTools.has(step.tool) || effect === "read";
    preflightSteps.push({
      id: step.id,
      tool: step.tool,
      params: step.params,
      spec,
      pins,
      autoApply: autoApplyStep,
      effect,
      requiresApproval: !autoApplyStep && toolSpendsMoney(step.tool),
    });
  }

  const effect = preflightSteps.some((step) => step.effect === "generation")
    ? "generation"
    : preflightSteps.some((step) => step.effect === "mutation")
      ? "mutation"
      : "read";
  // A step that stops for its own review does not also need the combined sheet.
  // A free in-place mutation still does, or it would run with no review at all.
  const autoApply = preflightSteps.every(
    (step) => step.autoApply || step.requiresApproval,
  );

  return {
    ok: true,
    plan: {
      version: CHAIN_VERSION,
      bookId: context.bookId,
      notebookId,
      requestId: data.request_id ?? null,
      steps: preflightSteps,
      fingerprint: chainPlanFingerprint({
        version: CHAIN_VERSION,
        notebookId,
        steps: data.steps,
      }),
      autoApply,
      effect,
    },
  };
}

export async function revalidatePinnedTargets(
  engine: Engine,
  notebookId: string | null,
  pins: readonly PinnedChainTarget[],
): Promise<string | null> {
  for (const pin of pins) {
    if (pin.cellId && notebookId) {
      const notebook = engine.notebooks.read(notebookId);
      if (!notebook.ok) return notebook.error.message;
      const cell = notebook.value.cells.find((candidate) => candidate.id === pin.cellId);
      if (!cell) return `Pinned cell for ${pin.address} is gone`;
      if (cell.outputArtifactId !== pin.artifactId) {
        return `Pinned target ${pin.address} no longer points at the same artifact`;
      }
    }
    const artifact = engine.artifacts.get(pin.artifactId);
    if (!artifact.ok) return `Pinned artifact ${pin.artifactId} is gone`;
    const hash = await primaryObjectHash(engine, pin.artifactId);
    if (pin.objectHash && hash && hash !== pin.objectHash) {
      return `Pinned target ${pin.address} changed since planning`;
    }
  }
  return null;
}

type StackedChainPlan = {
  steps: ChainStep[];
  message: string;
};

function uniqueGridMentions(query: string): string[] {
  const matches = [
    ...query.matchAll(new RegExp(`@(${GRID_TOKEN})(?![\\w-])`, "giu")),
    ...query.matchAll(new RegExp(`\\b(${GRID_TOKEN})\\b`, "giu")),
  ];
  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const match of matches) {
    const token = match[1]?.toLowerCase();
    if (!token || !parseNotebookGridAddress(token) || seen.has(token)) continue;
    seen.add(token);
    mentions.push(token);
  }
  return mentions;
}

function gridAfter(query: string, pattern: RegExp): string | null {
  const match = pattern.exec(query);
  const token = match?.[1]?.toLowerCase();
  return token && parseNotebookGridAddress(token) ? token : null;
}

function extractAudioReplacePlan(query: string): StackedChainPlan | null {
  if (!/\bextract(?:\s+the)?\s+audio\b/i.test(query)) return null;
  if (!/\breplace(?:\s+the)?\s+audio\b/i.test(query)) return null;
  const source = gridAfter(
    query,
    new RegExp(`\\bfrom\\s+@?(${GRID_TOKEN})\\b`, "iu"),
  ) ?? uniqueGridMentions(query)[0] ?? null;
  const target = gridAfter(
    query,
    new RegExp(
      `\\b(?:in|on)\\s+(?:the\\s+video\\s+(?:in|on)\\s+)?@?(${GRID_TOKEN})\\b`,
      "iu",
    ),
  ) ?? uniqueGridMentions(query)[1] ?? null;
  if (!source || !target || source === target) return null;
  return {
    message: "Extracting audio and replacing the target soundtrack.",
    steps: [
      {
        id: "extract",
        tool: "extract_audio",
        params: { asset_id: `@${source}` },
      },
      {
        id: "replace",
        tool: "replace_video_audio",
        params: {
          asset_id: `@${target}`,
          audio_asset_id: {
            $ref: { step_id: "extract", output: "audio_asset_id" },
          },
        },
      },
    ],
  };
}

function trimThenExtractPlan(query: string): StackedChainPlan | null {
  if (!/\btrim\b/i.test(query)) return null;
  if (!/\bextract(?:\s+the)?\s+audio\b/i.test(query)) return null;
  if (/\breplace(?:\s+the)?\s+audio\b/i.test(query)) return null;
  const mentions = uniqueGridMentions(query);
  const source = mentions[0];
  if (!source) return null;
  const seconds = query.match(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?\b/i)?.[1];
  const trimEnd = seconds ? Number(seconds) : 1;
  if (!Number.isFinite(trimEnd) || trimEnd <= 0) return null;
  return {
    message: "Trimming the clip then extracting audio.",
    steps: [
      {
        id: "trim",
        tool: "trim_video",
        params: {
          asset_id: `@${source}`,
          trim_start: 0,
          trim_end: trimEnd,
        },
      },
      {
        id: "extract",
        tool: "extract_audio",
        params: {
          asset_id: {
            $ref: { step_id: "trim", output: "asset_id" },
          },
        },
      },
    ],
  };
}

export function planStackedChainFromQuery(query: string): StackedChainPlan | null {
  return extractAudioReplacePlan(query) ?? trimThenExtractPlan(query);
}
