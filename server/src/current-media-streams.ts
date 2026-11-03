import type { ArtifactManifestFile, ArtifactStream, Engine } from "videobook-engine";

export function currentStreams(
  engine: Engine,
  artifactId: string,
  files: readonly ArtifactManifestFile[],
): ArtifactStream[] {
  const streams = engine.streams.list(artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  return streams.value.filter((stream) => files.some((file) =>
    file.name === stream.sourcePath && file.objectHash === stream.objectHash));
}

export async function currentStream(
  engine: Engine,
  artifactId: string,
  kind: "video" | "audio",
): Promise<ArtifactStream | undefined> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  return currentStreams(engine, artifactId, manifest.value.files)
    .find((stream) => stream.kind === kind);
}
