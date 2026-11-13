import { findPrimaryMediaFile, type Engine } from "videobook-engine";
import { formatShortSeconds } from "./goal-short-plan.js";
import { mimeForImageFilename } from "./jobs/describe-image.js";

type PlannerImage = { artifactId: string; name: string; text: string };

export async function goalPlannerImages(
  engine: Engine,
  references: readonly { artifactId: string; label: string }[],
  storyboard: readonly { artifactId: string; atSeconds: number }[] = [],
) {
  const images: PlannerImage[] = [
    ...references.map((reference, index) => ({ artifactId: reference.artifactId, name: `Source image ${index + 1}`, text: `Source image ${index + 1}: ${reference.label}` })),
    ...storyboard.map((frame, index) => ({
      artifactId: frame.artifactId,
      name: `Storyboard frame ${index + 1}`,
      text: `Storyboard frame ${index + 1} of ${storyboard.length} at ${formatShortSeconds(frame.atSeconds)} s`,
    })),
  ];
  return Promise.all(images.map(async (image) => {
    const manifest = await engine.files.manifest(image.artifactId);
    const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "image") : null;
    if (!file) throw new Error(`${image.name} has no readable image`);
    const bytes = await engine.files.read(image.artifactId, file.name);
    if (!bytes.ok) throw new Error(bytes.error.message);
    return [
      { type: "input_text" as const, text: image.text },
      { type: "input_image" as const, image_url: `data:${mimeForImageFilename(file.name)};base64,${bytes.value.toString("base64")}`, detail: "high" as const },
    ];
  })).then(parts => parts.flat());
}

export async function goalReferenceHashes(engine: Engine, artifactIds: readonly string[]) {
  return Promise.all(artifactIds.map(async artifactId => {
    const artifact = engine.artifacts.get(artifactId);
    const manifest = await engine.files.manifest(artifactId);
    const file = artifact.ok && manifest.ok ? findPrimaryMediaFile(manifest.value.files, artifact.value.kind) : null;
    return { artifactId, objectHash: file?.objectHash ?? null };
  }));
}
