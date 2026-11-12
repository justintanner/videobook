import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { getChainRun, preflightAndAccept } from "./chain-executor.js";
import { goalShortPlanSchema, shortSheetStep } from "./goal-short-plan.js";
import { assessToolCallEstimate } from "./jobs/cost-estimate-assessment.js";
import { resolveNotebookArtifactReference } from "./notebook-reference-resolver.js";

const MAIN_CHARACTER_KEY = "application.goal.main-character.v1";
const REFERENCE_LIMIT = 4;
const ACTIVE_STEP_STATUSES = new Set(["pending", "awaiting-approval", "approved", "running"]);
const characterFields = goalShortPlanSchema.shape.character.shape;

const mainCharacterSchema = z.object({
  version: z.literal(1),
  name: characterFields.name,
  description: characterFields.description,
  silent: z.literal(true),
  referenceArtifactIds: z.array(z.string().min(1)).max(REFERENCE_LIMIT),
  pending: z.object({
    chainId: z.string().min(1),
    stepId: z.string().min(1),
    notebookId: z.string().min(1),
  }).strict().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.string().nullable(),
}).strict();

export type MainCharacter = z.infer<typeof mainCharacterSchema>;

export type MainCharacterPatch = {
  name?: string;
  description?: string;
  referenceArtifactIds?: readonly string[];
};

export type MainCharacterView = {
  character: { name: string; description: string; silent: true };
  references: { artifactId: string; address: string | null; label: string | null }[];
  sheet: {
    estimate: { usd: number | null; warnings: string[] };
    pending: MainCharacter["pending"];
    lastError: string | null;
  };
};

function defaultMainCharacter(): MainCharacter {
  return {
    version: 1,
    name: "Main character",
    description: "a man in a green shirt",
    silent: true,
    referenceArtifactIds: [],
    pending: null,
    lastError: null,
    updatedAt: null,
  };
}

export function readMainCharacter(engine: Engine): MainCharacter {
  const stored = engine.settings.get<unknown>(MAIN_CHARACTER_KEY);
  if (stored === undefined || stored === null) return defaultMainCharacter();
  const parsed = mainCharacterSchema.safeParse(stored);
  if (!parsed.success) throw new Error(`The saved main character could not be read: ${parsed.error.issues[0]?.message ?? "invalid setting"}`);
  return parsed.data;
}

function writeMainCharacter(engine: Engine, character: MainCharacter): MainCharacter {
  const next = mainCharacterSchema.parse({ ...character, updatedAt: new Date().toISOString() });
  const written = engine.settings.set(MAIN_CHARACTER_KEY, next);
  if (!written.ok) throw new Error(written.error.message);
  return next;
}

function field(schema: z.ZodType<string>, value: string, message: string): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(message);
  return parsed.data;
}

function imageReferences(engine: Engine, ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length > REFERENCE_LIMIT) {
    throw new Error(`The main character takes at most ${REFERENCE_LIMIT} reference images, not ${unique.length}.`);
  }
  for (const id of unique) {
    const artifact = engine.artifacts.get(id);
    if (!artifact.ok) throw new Error(`Reference ${id} is not an image in this book.`);
    if (artifact.value.kind !== "image") throw new Error(`Reference ${artifact.value.label || id} is a ${artifact.value.kind}, not an image.`);
  }
  return unique;
}

export function saveMainCharacter(engine: Engine, patch: MainCharacterPatch): MainCharacter {
  const current = readMainCharacter(engine);
  return writeMainCharacter(engine, {
    ...current,
    ...(patch.name === undefined ? {} : {
      name: field(characterFields.name, patch.name, "The main character's name must be 1 to 80 characters."),
    }),
    ...(patch.description === undefined ? {} : {
      description: field(characterFields.description, patch.description, "The main character's description must be 1 to 400 characters."),
    }),
    ...(patch.referenceArtifactIds === undefined ? {} : { referenceArtifactIds: imageReferences(engine, patch.referenceArtifactIds) }),
  });
}

function cellAddress(document: NotebookDocument, artifactId: string): string | null {
  const cell = document.cells.find((candidate) => resolveNotebookCellArtifactId(document, candidate) === artifactId);
  return cell ? notebookGridTag(cell.slot) : null;
}

export function resolveCharacterReferences(engine: Engine, document: NotebookDocument, ids: readonly string[]): string[] {
  return ids.map((id) => {
    const resolved = resolveNotebookArtifactReference({ engine, documents: [document], reference: id });
    if ("code" in resolved) throw new Error(resolved.message);
    const artifact = engine.artifacts.get(resolved.artifactId);
    const kind = artifact.ok ? artifact.value.kind : null;
    if (kind === "video") throw new Error(`${resolved.mention} is a video. Choose an image cell, or use Extract frame on the video first.`);
    if (kind !== "image") throw new Error(`${resolved.mention} is not an image.`);
    if (cellAddress(document, resolved.artifactId) === null) throw new Error(`${resolved.mention} is not an image cell in this notebook.`);
    return resolved.artifactId;
  });
}

function sheetOutput(outputs: Record<string, unknown> | null): string | null {
  const id = outputs?.asset_id ?? outputs?.img_asset_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function sheetFailure(engine: Engine, artifactId: string | null): Promise<string | null> {
  if (!artifactId) return "it finished without an image";
  const artifact = engine.artifacts.get(artifactId);
  const status = await engine.status.get(artifactId);
  if (artifact.ok && artifact.value.kind === "image" && status.ok && status.value === "ready") return null;
  const failure = engine.jobs.failures.read(artifactId);
  return failure.ok && failure.value ? failure.value.message : "it finished without an image";
}

export async function reconcileMainCharacter(engine: Engine): Promise<MainCharacter> {
  const before = readMainCharacter(engine);
  const { pending } = before;
  if (!pending) return before;
  const run = getChainRun(engine, pending.chainId);
  const step = run?.steps.find((candidate) => candidate.id === pending.stepId);
  if (step && ACTIVE_STEP_STATUSES.has(step.status)) return before;
  const output = step?.status === "completed" ? sheetOutput(step.outputs) : null;
  const reason = step?.status === "completed"
    ? await sheetFailure(engine, output)
    : step?.error ?? run?.error ?? (step ? `it ended ${step.status}` : "its run is gone");
  const character = readMainCharacter(engine);
  if (character.pending?.chainId !== pending.chainId) return character;
  return writeMainCharacter(engine, output && reason === null
    ? { ...character, referenceArtifactIds: [output], pending: null, lastError: null }
    : { ...character, pending: null, lastError: `The character sheet was not made: ${reason}` });
}

export function requireCharacterSheetKey(): void {
  if (!process.env.FAL_API_KEY) throw new Error("Set FAL_API_KEY in Settings before generating a character sheet.");
}

export async function startCharacterSheet(engine: Engine, bookId: string, notebookId: string): Promise<MainCharacter> {
  requireCharacterSheetKey();
  const character = await reconcileMainCharacter(engine);
  if (character.pending) return character;
  const step = shortSheetStep({ description: character.description, references: character.referenceArtifactIds });
  const { getAllToolDefs } = await import("./tools/index.js");
  const defs = getAllToolDefs(engine);
  const chain = await preflightAndAccept({
    action: "run", version: 1, book_id: bookId, notebook_id: notebookId,
    request_id: `main-character-sheet:${uuidv7()}`,
    steps: [step],
  }, {
    engine, bookId, notebookId,
    toolSchemas: new Map(defs.map((def) => [def.name, def.schema])),
    autoApplyTools: new Set(),
    effectForTool: () => "generation",
  }, (name) => defs.find((def) => def.name === name), { actor: "chat" });
  return writeMainCharacter(engine, {
    ...readMainCharacter(engine),
    pending: { chainId: chain.chainId, stepId: step.id, notebookId },
    lastError: null,
  });
}

export function forgetMainCharacterReference(engine: Engine, artifactId: string): void {
  const character = readMainCharacter(engine);
  if (!character.referenceArtifactIds.includes(artifactId)) return;
  writeMainCharacter(engine, {
    ...character,
    referenceArtifactIds: character.referenceArtifactIds.filter((id) => id !== artifactId),
  });
}

export function clearMainCharacterError(engine: Engine, reported: string | null): void {
  if (reported === null) return;
  const character = readMainCharacter(engine);
  if (character.lastError === reported) writeMainCharacter(engine, { ...character, lastError: null });
}

export async function describeMainCharacter(engine: Engine, document: NotebookDocument, character: MainCharacter): Promise<MainCharacterView> {
  const step = shortSheetStep({ description: character.description, references: character.referenceArtifactIds });
  const estimate = await assessToolCallEstimate(engine, step.tool, { book_id: engine.book.get().bookId, ...step.params });
  return {
    character: { name: character.name, description: character.description, silent: character.silent },
    references: character.referenceArtifactIds.map((artifactId) => {
      const artifact = engine.artifacts.get(artifactId);
      return { artifactId, address: cellAddress(document, artifactId), label: artifact.ok ? artifact.value.label ?? null : null };
    }),
    sheet: {
      estimate: { usd: estimate.available ? estimate.usd : null, warnings: estimate.warnings },
      pending: character.pending,
      lastError: character.lastError,
    },
  };
}
