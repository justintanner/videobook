import { z } from "zod";
import type { Engine, NotebookCell } from "videobook-engine";
import { goalReferenceHashes } from "./goal-reference-images.js";

export const goalGenerationOriginSchema = z.object({
  version: z.literal(1),
  goalId: z.string().uuid(),
  stage: z.enum(["storyboards", "replacement", "frame", "videos"]),
  index: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative().nullable(),
  fingerprint: z.string(),
  basePrompt: z.string(),
  frameArtifactId: z.string().nullable(),
  source: z.object({ artifactId: z.string(), mediaHash: z.string() }).strict().nullable(),
  transcribe: z.literal(false).optional(),
}).strict();

export type GoalGenerationOrigin = z.infer<typeof goalGenerationOriginSchema>;

export const goalGenerationLineageSchema = z.object({
  version: z.literal(1),
  origin: goalGenerationOriginSchema,
  references: z.array(z.object({ role: z.string(), index: z.number(), artifactId: z.string(), objectHash: z.string().nullable() })),
});

export type GoalGenerationLineage = z.infer<typeof goalGenerationLineageSchema>;

export function cellGoalOrigin(cell: Pick<NotebookCell, "inputs">): GoalGenerationOrigin | undefined {
  const parsed = goalGenerationOriginSchema.safeParse(cell.inputs?.goalOrigin);
  return parsed.success ? parsed.data : undefined;
}

export async function generationReferenceSnapshot(engine: Engine, refs: Readonly<Record<string, readonly string[] | undefined>>) {
  const bindings = Object.entries(refs).flatMap(([role, ids]) => (ids ?? []).map((artifactId, index) => ({ role, index, artifactId })));
  const hashes = await goalReferenceHashes(engine, bindings.map(binding => binding.artifactId));
  return bindings.map((binding, index) => ({ ...binding, objectHash: hashes[index]?.objectHash ?? null }));
}

export async function assertGoalLineageCurrent(engine: Engine, lineage: GoalGenerationLineage): Promise<void> {
  const current = await goalReferenceHashes(engine, lineage.references.map(reference => reference.artifactId));
  if (lineage.references.some((reference, index) => reference.objectHash !== current[index]?.objectHash)) throw new Error("A goal reference changed before submission. Review the current inputs before generating.");
  if (lineage.origin.source) {
    const [source] = await goalReferenceHashes(engine, [lineage.origin.source.artifactId]);
    if (source?.objectHash !== lineage.origin.source.mediaHash) throw new Error("The goal's source changed before generation. Review the current source before submitting.");
  }
}
