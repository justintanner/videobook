import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { resolveGeneratedVideoArtifact } from 'videobook-engine/notebook-media-artifact'
import { normalizeNotebookReference } from 'videobook-engine/notebook-mentions'
import {
  notebookCellTag,
  resolveNotebookCellReference,
} from './notebook-addressing'

const notebookVideoSourceTypes = new Set<NotebookCell['type']>([
  'video',
  'generate_video',
  'concat',
  'splice',
])

function cellForArtifactReference(
  document: NotebookDocument,
  sourceReference: string,
): NotebookCell | null {
  const artifactId = normalizeNotebookReference(sourceReference)
  const direct = document.cells.find((cell) =>
    cell.outputArtifactId?.toLowerCase() === artifactId)
  if (direct) return direct
  return document.cells.find((cell) =>
    notebookVideoSourceTypes.has(cell.type)
    && resolveGeneratedVideoArtifact(document, cell)?.toLowerCase() === artifactId,
  ) ?? null
}

export function resolveNotebookVideoSourceCell(
  document: NotebookDocument,
  sourceReference: string,
): NotebookCell {
  let source: NotebookCell
  try {
    source = resolveNotebookCellReference(document, sourceReference)
  } catch (cause) {
    const artifactCell = cellForArtifactReference(document, sourceReference)
    if (!artifactCell) throw cause
    source = artifactCell
  }
  if (!notebookVideoSourceTypes.has(source.type)) {
    throw new Error(`${notebookCellTag(source)} is not a video-producing cell`)
  }
  if (!resolveGeneratedVideoArtifact(document, source)) {
    throw new Error(`${notebookCellTag(source)} does not have a video output yet`)
  }
  return source
}
