import type { Engine, NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { replaceNotebookMentions, scanNotebookMentions } from "videobook-engine/notebook-mentions";
import { resolveNotebookPromptReferences } from "./notebook-reference-resolver.js";
import type { GoalCharacter } from "./goal-plan.js";

const GOAL_CHARACTER_HELP = "Mention the reference images in the brief, for example /goal @a1 @a2 as ...";

export function resolveGoalCharacters(engine: Engine, document: NotebookDocument, brief: string): GoalCharacter[] {
  if (scanNotebookMentions(brief).length === 0) throw new Error(GOAL_CHARACTER_HELP);
  const resolved = resolveNotebookPromptReferences({ engine, document, prompt: brief, requireMedia: true });
  if (resolved.unresolved.length > 0) throw new Error(resolved.unresolved[0]!.message);
  const characters = new Map<string, GoalCharacter>();
  for (const reference of resolved.resolved) {
    const artifact = engine.artifacts.get(reference.artifactId);
    const cell = document.cells.find(candidate => candidate.id === reference.cellId);
    if (!artifact.ok || artifact.value.kind !== "image" || !cell || !["image", "generate_image"].includes(cell.type)) {
      throw new Error(`${reference.mention} is not an image`);
    }
    if (!characters.has(reference.artifactId)) characters.set(reference.artifactId, {
      artifactId: reference.artifactId, cellId: cell.id, address: notebookGridTag(cell.slot),
      label: artifact.value.label || cell.label || `Character ${characters.size + 1}`,
    });
  }
  if (characters.size === 0) throw new Error(GOAL_CHARACTER_HELP);
  if (characters.size > 8) throw new Error("A goal supports 1–8 reference images");
  return [...characters.values()];
}

export function currentGoalCharacters(document: NotebookDocument, characters: readonly GoalCharacter[]): GoalCharacter[] {
  return characters.map(character => {
    const cell = document.cells.find(candidate => candidate.id === character.cellId);
    if (!cell || resolveNotebookCellArtifactId(document, cell) !== character.artifactId) {
      throw new Error(`Reference image ${character.address} changed or was removed. Start a new /goal.`);
    }
    return { ...character, address: notebookGridTag(cell.slot) };
  });
}

export function goalPlannerBrief(brief: string, characters: readonly GoalCharacter[], document?: NotebookDocument): string {
  const aliases = document?.cells.flatMap(cell => {
    const index = characters.findIndex(character => character.artifactId === resolveNotebookCellArtifactId(document, cell));
    return index < 0 ? [] : [{ reference: notebookGridTag(cell.slot), replacement: `Character ${index + 1}` }];
  }) ?? [];
  return replaceNotebookMentions(brief, [...characters.flatMap((character, index) => [
    { reference: character.address.slice(1), replacement: `Character ${index + 1}` },
    { reference: character.artifactId, replacement: `Character ${index + 1}` },
  ]), ...aliases]).replace(/(Character \d)(?=Character \d)/gu, "$1 ");
}
