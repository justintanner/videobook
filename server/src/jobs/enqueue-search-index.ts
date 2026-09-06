import { findPrimaryMediaFile, type Engine } from "videobook-engine";
import { appendDiagnostic } from "../diagnostics.js";
import { enqueueOptions } from "../queue.js";

export async function enqueueSearchIndex(engine: Engine, artifactId: string): Promise<void> {
  try {
    const artifact = engine.artifacts.get(artifactId);
    if (!artifact.ok) throw new Error(artifact.error.message);
    if (!["image", "video", "audio", "final"].includes(artifact.value.kind)) return;
    const manifest = await engine.withLocalMedia(() => engine.files.manifest(artifactId));
    if (!manifest.ok) throw Object.assign(new Error(manifest.error.message), { name: manifest.error.code });
    const source = findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
    if (!source) throw new Error("No media source is available for indexing");
    engine.jobs.queue.enqueue(enqueueOptions(`semantic-index:${artifactId}:${source.objectHash}`, {
      type: "semantic_index", prepareVisualMedia: true, assetId: artifactId, bookId: engine.book.get().bookId,
    }));
  } catch (error) {
    await appendDiagnostic(engine, "semantic-index-deferred", { artifactId, error }).catch(() => undefined);
  }
}
