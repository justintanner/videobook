import { findPrimaryMediaFile, type Engine } from "videobook-engine";
import type { GoalCharacter } from "./goal-plan.js";
import { mimeForImageFilename } from "./jobs/describe-image.js";

export async function goalPlannerImages(engine: Engine, references: readonly GoalCharacter[]) {
  return Promise.all(references.map(async (reference, index) => {
    const manifest = await engine.files.manifest(reference.artifactId);
    const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "image") : null;
    if (!file) throw new Error(`Reference ${index + 1} has no readable image`);
    const bytes = await engine.files.read(reference.artifactId, file.name);
    if (!bytes.ok) throw new Error(bytes.error.message);
    return [
      { type: "input_text" as const, text: `Reference ${index + 1}: ${reference.label}` },
      { type: "input_image" as const, image_url: `data:${mimeForImageFilename(file.name)};base64,${bytes.value.toString("base64")}`, detail: "high" as const },
    ];
  })).then(images => images.flat());
}

export async function goalReferenceHashes(engine: Engine, artifactIds: readonly string[]) {
  return Promise.all(artifactIds.map(async artifactId => {
    const artifact = engine.artifacts.get(artifactId);
    const manifest = await engine.files.manifest(artifactId);
    const file = artifact.ok && manifest.ok ? findPrimaryMediaFile(manifest.value.files, artifact.value.kind) : null;
    return { artifactId, objectHash: file?.objectHash ?? null };
  }));
}
