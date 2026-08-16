import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { Engine } from "videobook-engine";

export async function ingestWorkspaceOutputs(
  engine: Engine,
  artifact: string,
  paths: string[],
  operation: string,
  details: Record<string, unknown> = {},
): Promise<string> {
  const result = await engine.files.ingestWorkspace(artifact, paths, operation, details);
  if (!result.ok) {
    throw new Error(
      `Failed to ingest ${artifact} workspace output: ${result.error.message}`,
    );
  }
  return result.value;
}

export async function replaceArtifactFileFromPath(
  engine: Engine,
  artifact: string,
  targetFilename: string,
  sourcePath: string,
): Promise<string> {
  const result = await engine.files.writeFromPath(artifact, targetFilename, sourcePath);
  if (!result.ok) {
    throw new Error(
      `Failed to persist ${artifact}/${targetFilename}: ${result.error.message}`,
    );
  }
  if (resolve(sourcePath) !== resolve(result.value)) {
    await rm(sourcePath, { force: true });
  }
  return result.value;
}
