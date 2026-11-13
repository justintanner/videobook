import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";

export type UsableImage = {
  kind: "image";
  artifactId: string;
  cellId: string;
  address: string;
  label: string;
  objectHash: string;
};

type FrameMetadata = {
  origin?: string;
  sourceArtifactId?: string;
  atSeconds?: number;
};

export async function readableImage(engine: Engine, artifactId: string, cell: NotebookCell): Promise<UsableImage | null> {
  const manifest = await engine.files.manifest(artifactId);
  const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "image") : null;
  if (!file) return null;
  const address = notebookGridTag(cell.slot);
  const artifact = engine.artifacts.get(artifactId);
  return {
    kind: "image",
    artifactId,
    cellId: cell.id,
    address,
    label: (artifact.ok && artifact.value.label) || cell.label || address,
    objectHash: file.objectHash,
  };
}

function sameFrame(inputs: Record<string, unknown> | undefined, sourceArtifactId: string, sourceCellId: string | undefined, requestedSeconds: number): boolean {
  if (!inputs || inputs.mediaRole !== "extract-frame-output") return false;
  const sameSource = inputs.sourceArtifactId === sourceArtifactId || (sourceCellId !== undefined && inputs.sourceCellId === sourceCellId);
  if (!sameSource) return false;
  if (typeof inputs.requestedSeconds === "number") return Math.abs(inputs.requestedSeconds - requestedSeconds) < 0.001;
  return typeof inputs.atSeconds === "number" && Math.abs(inputs.atSeconds - requestedSeconds) <= 0.05;
}

export async function existingFrameCell(engine: Engine, document: NotebookDocument, sourceArtifactId: string, sourceCellId: string | undefined, requestedSeconds: number): Promise<NotebookCell | null> {
  for (const cell of document.cells) {
    if (cell.type !== "image" || !cell.outputArtifactId) continue;
    if (cell.inputs?.mediaRole === "extract-frame-output") {
      if (sameFrame(cell.inputs, sourceArtifactId, sourceCellId, requestedSeconds) && await readableImage(engine, cell.outputArtifactId, cell)) return cell;
      continue;
    }
    try {
      const metadata = await engine.metadata.artifacts.read<FrameMetadata>(cell.outputArtifactId, "original");
      if (!metadata.ok || metadata.value.origin !== "extract_frame" || metadata.value.sourceArtifactId !== sourceArtifactId) continue;
      if (typeof metadata.value.atSeconds !== "number" || Math.abs(metadata.value.atSeconds - requestedSeconds) > 0.05) continue;
      if (await readableImage(engine, cell.outputArtifactId, cell)) return cell;
    } catch {
      continue;
    }
  }
  return null;
}
