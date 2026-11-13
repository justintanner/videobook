import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridTag, parseNotebookGridAddress } from "videobook-engine/notebook-grid";
import { getChainRun, preflightAndAccept } from "./chain-executor.js";
import { goalShortPlanSchema, shortSheetStep } from "./goal-short-plan.js";
import { renderReferenceNotes, usableImageReference, type ReferenceNote } from "./goal-short-references.js";
import { assessToolCallEstimate } from "./jobs/cost-estimate-assessment.js";

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
  notes: string[];
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

function readNotebook(engine: Engine, notebookId: string): NotebookDocument {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return notebook.value;
}

function referenceMention(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function characterReferenceTarget(document: NotebookDocument, id: string): { target: string; mention: string } {
  const trimmed = id.trim();
  const mention = referenceMention(trimmed);
  const bare = trimmed.replace(/^@/u, "");
  const slot = parseNotebookGridAddress(bare);
  const cell = slot
    ? document.cells.find((candidate) => candidate.slot.row === slot.row && candidate.slot.column === slot.column)
    : document.cells.find((candidate) => candidate.id === bare || candidate.outputArtifactId === bare);
  return { target: cell?.id ?? (slot ? mention : bare), mention };
}

async function imageReferences(engine: Engine, notebookId: string, ids: readonly string[]): Promise<{ artifactIds: string[]; notes: string[] }> {
  const document = readNotebook(engine, notebookId);
  const artifactIds: string[] = [];
  const pending: ReferenceNote[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const { target, mention } = characterReferenceTarget(document, id);
    if (seen.has(target)) continue;
    seen.add(target);
    const result = await usableImageReference(engine, notebookId, target, {
      accept: artifactIds.length < REFERENCE_LIMIT,
      mention,
    });
    if (result.ignored) continue;
    if (result.image) {
      if (artifactIds.includes(result.image.artifactId)) continue;
      artifactIds.push(result.image.artifactId);
      if (result.frame) pending.push({ kind: "frame", mention, cellId: result.frame.cellId, atSeconds: result.frame.atSeconds });
      continue;
    }
    if (result.countable) pending.push({ kind: "text", text: `${mention} was skipped because the main character takes at most ${REFERENCE_LIMIT} reference images.` });
    else if (result.note) pending.push({ kind: "text", text: result.note });
  }
  const notes = renderReferenceNotes(readNotebook(engine, notebookId), pending);
  if (ids.length > 0 && artifactIds.length === 0) throw new Error(notes.join(" ") || "None of the character references could be used.");
  return { artifactIds, notes };
}

export async function resolveCharacterReferences(engine: Engine, notebookId: string, ids: readonly string[]): Promise<{ artifactIds: string[]; notes: string[] }> {
  return imageReferences(engine, notebookId, ids);
}

export async function saveMainCharacter(engine: Engine, patch: MainCharacterPatch, notebookId?: string): Promise<MainCharacter> {
  const current = readMainCharacter(engine);
  let referenceArtifactIds: string[] | undefined;
  if (patch.referenceArtifactIds !== undefined) {
    if (patch.referenceArtifactIds.length === 0) referenceArtifactIds = [];
    else {
      if (!notebookId) throw new Error("Choose a notebook before saving character references.");
      referenceArtifactIds = (await imageReferences(engine, notebookId, patch.referenceArtifactIds)).artifactIds;
    }
  }
  return writeMainCharacter(engine, {
    ...current,
    ...(patch.name === undefined ? {} : {
      name: field(characterFields.name, patch.name, "The main character's name must be 1 to 80 characters."),
    }),
    ...(patch.description === undefined ? {} : {
      description: field(characterFields.description, patch.description, "The main character's description must be 1 to 400 characters."),
    }),
    ...(referenceArtifactIds === undefined ? {} : { referenceArtifactIds }),
  });
}

function cellAddress(document: NotebookDocument, artifactId: string): string | null {
  const cell = document.cells.find((candidate) => resolveNotebookCellArtifactId(document, candidate) === artifactId);
  return cell ? notebookGridTag(cell.slot) : null;
}

function sheetOutput(outputs: Record<string, unknown> | null): string | null {
  const id = outputs?.asset_id ?? outputs?.img_asset_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function sheetFailure(engine: Engine, artifactId: string | null): Promise<string | null> {
  const artifact = artifactId ? engine.artifacts.get(artifactId) : null;
  if (!artifactId || !artifact?.ok || artifact.value.kind !== "image") return "it finished without an image";
  const status = await engine.status.get(artifactId);
  if (status.ok && status.value !== "error") return null;
  const failure = engine.jobs.failures.read(artifactId);
  return failure.ok && failure.value ? failure.value.message : "its image failed";
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
    notes: [],
    sheet: {
      estimate: { usd: estimate.available ? estimate.usd : null, warnings: estimate.warnings },
      pending: character.pending,
      lastError: character.lastError,
    },
  };
}
