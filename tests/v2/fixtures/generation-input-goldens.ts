import { createHash } from "node:crypto";
import type { NotebookCell, NotebookDocument } from "videobook-engine";
import { generationInputMentions } from "../../../server/src/generation-input-mentions.js";
import {
  mediaGenerationArgs,
  notebookCellDefinitionFingerprint,
  notebookCellFingerprint,
} from "../../../server/src/jobs/run-notebook.js";
import { MODEL_ENTRIES } from "../../../server/src/media/catalog.js";
import { resolveEntry } from "../../../server/src/media/descriptor.js";
import { modelListing } from "../../../server/src/media/listing.js";
import { previewGeneration } from "../../../server/src/media/preview.js";
import type { RefRole, ResolvedModel } from "../../../server/src/media/types.js";
import {
  notebookGenerationInputContract,
  notebookGenerationInputError,
  notebookGenerationInputsAreCompatible,
} from "../../../server/src/notebook-generation-contract.js";
import { controlsForModel } from "../../../server/src/notebook-generation-controls.js";
import { seedInitialGenerationPrompt } from "../../../server/src/notebook-initial-generation-prompt.js";

type InputKind = "image" | "video" | "audio";

interface LayoutEdge {
  kind: InputKind;
  targetInput: string;
}

interface Layout {
  name: string;
  edges: LayoutEdge[];
  hashOnly?: boolean;
  settings?: Record<string, string | number | boolean>;
}

const GENERATION_CELL_ID = "01900000-0000-7000-8000-00000000a000";
const ROLE_KIND: Readonly<Record<RefRole, InputKind>> = {
  image: "image",
  first_frame: "image",
  last_frame: "image",
  loop: "image",
  keyframe: "image",
  video: "video",
  audio: "audio",
};

function numbered(base: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => (index === 0 ? base : `${base}_${index + 1}`));
}

function edgesFor(kind: InputKind, names: readonly string[]): LayoutEdge[] {
  return names.map((targetInput) => ({ kind, targetInput }));
}

function layoutsFor(model: ResolvedModel): Layout[] {
  const roles = model.slots.map((slot) => slot.role);
  const multi = new Set(model.slots.filter((slot) => slot.max === null || slot.max > 1).map((slot) => slot.role));
  const layouts: Layout[] = [{ name: "empty", edges: [] }];
  for (const role of roles) {
    layouts.push({ name: `${role}x1`, edges: edgesFor(ROLE_KIND[role], [role]) });
    if (multi.has(role)) layouts.push({ name: `${role}x2`, edges: edgesFor(ROLE_KIND[role], numbered(role, 2)) });
    if (multi.has(role) && role === "image") layouts.push({ name: "imagex3", edges: edgesFor("image", numbered("image", 3)) });
  }
  const all = roles.flatMap((role) => edgesFor(ROLE_KIND[role], numbered(role, multi.has(role) ? 2 : 1)));
  if (roles.length > 1) layouts.push({ name: "all", edges: all });
  if (roles.includes("first_frame") || roles.includes("last_frame")) {
    layouts.push({ name: "frames", edges: edgesFor("image", ["first_frame", "last_frame"]) });
  }
  if (roles.includes("loop")) {
    layouts.push({ name: "loop+keyframes", edges: [...edgesFor("image", ["loop"]), ...edgesFor("image", numbered("keyframe", 2))] });
  }
  if (model.media === "video") {
    layouts.push({ name: "all+replace_audio", edges: [...all, { kind: "audio", targetInput: "replace_audio" }] });
  }
  const odd: LayoutEdge[] = [];
  if (roles.some((role) => ROLE_KIND[role] === "image")) odd.push(...edgesFor("image", ["image_0", "first_frame_2", "media"]));
  if (roles.includes("video")) odd.push({ kind: "video", targetInput: "video_3" });
  if (roles.includes("audio")) odd.push({ kind: "audio", targetInput: "scene_audio" });
  if (odd.length > 0) layouts.push({ name: "odd-names", edges: odd, hashOnly: true });
  return [...layouts, ...settingsVariants(model)];
}

function settingsVariants(model: ResolvedModel): Layout[] {
  if (model.id === "kie:grok-imagine-video-1-5-preview") {
    return [
      { name: "keyframes+seconds", edges: [...edgesFor("image", ["image"]), ...edgesFor("image", numbered("keyframe", 2))], settings: { keyframe_1_seconds: 2, keyframe_2_seconds: 5 } },
      { name: "images-at-1080p", edges: edgesFor("image", numbered("image", 2)), settings: { resolution: "1080p" } },
    ];
  }
  if (model.id === "kie:bytedance/seedance-2-5") {
    return [{ name: "edit-video", edges: edgesFor("video", ["video"]), settings: { duration: 5 } }];
  }
  return [];
}

function modesFor(model: ResolvedModel): string[] {
  const ids = model.modes.map((mode) => mode.id);
  return ids.length > 1 ? [...ids, "unset"] : ids;
}

function sourceCell(index: number, kind: InputKind): NotebookCell {
  return {
    id: `01900000-0000-7000-8000-00000000b${String(index).padStart(3, "0")}`,
    type: kind,
    slot: { row: 0, column: index },
    prompt: `${kind} cue ${index + 1}`,
    outputArtifactId: `art-${kind}-${index + 1}`,
  };
}

function documentFor(model: ResolvedModel, layout: Layout, mode: string): NotebookDocument {
  const sources = layout.edges.map((edge, index) => sourceCell(index, edge.kind));
  const inputs: Record<string, unknown> = {
    ...(mode === "unset" ? {} : { generationMode: mode }),
    ...(layout.settings ? { generationSettings: layout.settings } : {}),
  };
  const generation: NotebookCell = {
    id: GENERATION_CELL_ID,
    type: `generate_${model.media}`,
    slot: { row: 1, column: 0 },
    prompt: "",
    provider: model.provider,
    model: model.id,
    operation: model.entry.operations[0] ?? "",
    tool: `generate_${model.media}`,
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
  };
  const document: NotebookDocument = {
    id: "01900000-0000-7000-8000-00000000c000",
    name: "goldens",
    createdAt: "2026-01-01T00:00:00.000Z",
    cells: [generation, ...sources],
    edges: layout.edges.map((edge, index) => ({
      id: `01900000-0000-7000-8000-00000000d${String(index).padStart(3, "0")}`,
      source: sources[index]!.id,
      target: GENERATION_CELL_ID,
      targetInput: edge.targetInput,
    })),
  };
  return seedInitialGenerationPrompt(document, GENERATION_CELL_ID);
}

function previewRecord(input: Record<string, unknown>): unknown {
  try {
    const preview = previewGeneration(input);
    return preview.ok ? preview.preview.payload : { error: preview.error };
  } catch (cause) {
    return { threw: cause instanceof Error ? cause.message : String(cause) };
  }
}

function caseRecord(model: ResolvedModel, layout: Layout, mode: string): Record<string, unknown> {
  const document = documentFor(model, layout, mode);
  const cell = document.cells.find((candidate) => candidate.id === GENERATION_CELL_ID)!;
  const contract = notebookGenerationInputContract(model);
  const modeId = mode === "unset" ? undefined : mode;
  const compatible = notebookGenerationInputsAreCompatible(contract, document, cell, modeId);
  const record: Record<string, unknown> = {
    model: model.id,
    layout: layout.name,
    mode,
    edges: layout.edges.map((edge) => `${edge.kind}:${edge.targetInput}`),
    compatible,
    inputError: notebookGenerationInputError(contract, document, cell, modeId),
    tokens: generationInputMentions(GENERATION_CELL_ID, document.cells, document.edges, modeId)
      .map((mention) => `${mention.token}:${mention.targetInput}`),
    seededPrompt: cell.prompt ?? "",
    fingerprint: notebookCellFingerprint(document, cell).slice(0, 16),
    definitionFingerprint: notebookCellDefinitionFingerprint(document, cell).slice(0, 16),
  };
  if (compatible) {
    const { input, mentions } = mediaGenerationArgs(model, document, cell, "book");
    record.args = {
      refs: input.refs,
      options: input.options,
      mode: input.mode ?? null,
      prompt: input.prompt ?? null,
      replaceAudioWith: input.replace_audio_with ?? null,
    };
    record.unresolved = mentions.unresolved.map((issue) => issue.code);
    record.payload = previewRecord(input);
  }
  if (!layout.hashOnly) return record;
  return {
    model: model.id,
    layout: layout.name,
    mode,
    hash: createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 32),
  };
}

function modelRecord(model: ResolvedModel): Record<string, unknown> {
  const listing = modelListing(model);
  return {
    model: model.id,
    contract: {
      modes: notebookGenerationInputContract(model).modes.map(({ id, slots, requiredGroups }) => ({ id, slots, requiredGroups })),
    },
    refs: listing.refs,
    options: listing.options.map((option) => option.name),
    controls: controlsForModel(model).map((control) => control.name),
  };
}

function shardName(model: ResolvedModel): string {
  if (model.provider !== "fal") return model.provider;
  const owner = model.apiId.split("/")[0] ?? "other";
  return owner === "fal-ai" ? "fal-ai" : "fal-partners";
}

export function renderGenerationInputGoldens(): Map<string, string> {
  const shards = new Map<string, string[]>();
  for (const entry of MODEL_ENTRIES) {
    const model = resolveEntry(entry);
    const lines = shards.get(shardName(model)) ?? [];
    lines.push(JSON.stringify(modelRecord(model)));
    for (const layout of layoutsFor(model)) {
      for (const mode of modesFor(model)) lines.push(JSON.stringify(caseRecord(model, layout, mode)));
    }
    shards.set(shardName(model), lines);
  }
  return new Map([...shards.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, lines]) => [name, `[\n${lines.join(",\n")}\n]\n`]));
}
