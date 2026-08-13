import type {
  ArtifactKind,
  Engine,
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
  NotebookGridSlot,
} from "videobook-engine";
import {
  NOTEBOOK_GRID_ROW_COUNT,
  notebookGridTag,
  parseNotebookGridAddress,
} from "videobook-engine/notebook-grid";
import { z } from "zod";
import { mutateNotebook } from "../notebook-mutations.js";
import type { ToolDef } from "./tool-def.js";

const destinationSchema = z.string()
  .regex(/^@?[a-z](?:1[0-3]|[1-9])$/iu)
  .describe("Optional empty destination cell from a1 through z13");

function mediaCellType(kind: ArtifactKind): NotebookCellType | null {
  if (kind === "final") return "video";
  return kind === "audio" || kind === "image" || kind === "video"
    ? kind
    : null;
}

function sourceCellForArtifact(
  notebook: NotebookDocument,
  artifactId: string,
  cellType: NotebookCellType,
): NotebookCell | null {
  return notebook.cells.find((cell) =>
    cell.outputArtifactId === artifactId && cell.type === cellType)
    ?? notebook.cells.find((cell) => cell.outputArtifactId === artifactId)
    ?? null;
}

function duplicateDestination(
  notebook: NotebookDocument,
  source: NotebookCell | null,
  requested: string | undefined,
): NotebookGridSlot {
  const destination = requested
    ? parseNotebookGridAddress(requested)
    : source && source.slot.row + 1 < NOTEBOOK_GRID_ROW_COUNT
      ? { row: source.slot.row + 1, column: source.slot.column }
      : null;
  if (!destination) {
    throw new Error(source
      ? `${notebookGridTag(source.slot)} has no cell below it; choose a destination`
      : "Choose a destination because the source asset is not in this notebook");
  }
  const occupied = notebook.cells.find((cell) =>
    cell.slot.row === destination.row
    && cell.slot.column === destination.column);
  if (occupied) {
    throw new Error(`Notebook cell ${notebookGridTag(destination)} is occupied`);
  }
  return destination;
}

function failure(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

async function copyOriginalMetadata(
  fs: Engine,
  sourceAssetId: string,
  destinationAssetId: string,
): Promise<void> {
  const sourceMetadata = await fs.metadata.artifacts.read<Record<string, unknown>>(
    sourceAssetId,
    "original",
  );
  if (!sourceMetadata.ok) {
    if (sourceMetadata.error.code === "NOT_FOUND") return;
    throw new Error(sourceMetadata.error.message);
  }
  const metadataWrite = await fs.metadata.artifacts.write(
    destinationAssetId,
    "original",
    sourceMetadata.value,
  );
  if (!metadataWrite.ok) throw new Error(metadataWrite.error.message);
}

export function duplicateAssetDef(fs: Engine): ToolDef {
  return {
    name: "duplicate_asset",
    description: "Duplicate a media asset and place its notebook cell at an optional destination or directly below the source",
    schema: {
      asset_id: z.string().describe("Artifact id to duplicate"),
      book_id: z.string().describe("Book UUID"),
      new_name: z.string().optional().describe("Optional custom name for the copy"),
      notebook_id: z.string().uuid().optional().describe("Open notebook receiving the duplicate cell"),
      destination: destinationSchema.optional(),
    },
    handler: async (args) => {
      const {
        asset_id,
        book_id: _book_id,
        destination,
        new_name,
        notebook_id,
      } = args as {
        asset_id: string;
        book_id: string;
        destination?: string;
        new_name?: string;
        notebook_id?: string;
      };
      const sourceArtifact = fs.artifacts.get(asset_id);
      if (!sourceArtifact.ok) {
        return failure(sourceArtifact.error.message);
      }
      const manifestResult = await fs.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return failure(manifestResult.error.message);
      }

      const name = new_name
        ?? (sourceArtifact.value.label ? `${sourceArtifact.value.label} copy` : undefined);
      const cellType = mediaCellType(sourceArtifact.value.kind);
      if (destination && !notebook_id) {
        return failure("A duplicate destination requires notebook_id");
      }
      if (notebook_id) {
        if (!cellType) {
          return failure(`A ${sourceArtifact.value.kind} artifact cannot be placed in a media cell`);
        }
        const notebook = fs.notebooks.read(notebook_id);
        if (!notebook.ok) return failure(notebook.error.message);
        try {
          duplicateDestination(
            notebook.value,
            sourceCellForArtifact(notebook.value, asset_id, cellType),
            destination,
          );
        } catch (cause) {
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      }

      const createResult = await fs.artifacts.create({
        kind: sourceArtifact.value.kind,
        ...(name ? { label: name } : {}),
      });
      if (!createResult.ok) {
        return failure(createResult.error.message);
      }

      const newAssetId = createResult.value.artifactId;

      for (const file of manifestResult.value.files) {
        const readResult = await fs.files.read(asset_id, file.name);
        if (!readResult.ok) {
          await fs.artifacts.delete(newAssetId);
          return failure(readResult.error.message);
        }
        const writeResult = await fs.files.write(newAssetId, file.name, readResult.value);
        if (!writeResult.ok) {
          await fs.artifacts.delete(newAssetId);
          return failure(writeResult.error.message);
        }
      }

      try {
        await copyOriginalMetadata(fs, asset_id, newAssetId);
      } catch (cause) {
        await fs.artifacts.delete(newAssetId);
        return failure(cause instanceof Error ? cause.message : String(cause));
      }

      const placement: { cell: NotebookCell | null } = { cell: null };
      if (notebook_id && cellType) {
        try {
          const notebookResult = await mutateNotebook(
            fs,
            notebook_id,
            "duplicate_asset",
            (notebook) => {
              const slot = duplicateDestination(
                notebook,
                sourceCellForArtifact(notebook, asset_id, cellType),
                destination,
              );
              placement.cell = fs.notebooks.createCell({
                type: cellType,
                ...(name ? { label: name } : {}),
                slot,
                inputs: {
                  sourceOperation: "duplicate_asset",
                  sourceArtifactId: asset_id,
                  state: "completed",
                },
                outputArtifactId: newAssetId,
              });
              return {
                ...notebook,
                cells: [...notebook.cells, placement.cell],
              };
            },
            {
              sourceArtifactId: asset_id,
              newArtifactId: newAssetId,
              destination: destination ?? null,
            },
            { artifactId: newAssetId },
          );
          if (!notebookResult.ok) throw new Error(notebookResult.error.message);
        } catch (cause) {
          await fs.artifacts.delete(newAssetId);
          return failure(cause instanceof Error ? cause.message : String(cause));
        }
      }

      const createdCell = placement.cell;
      const address = createdCell ? notebookGridTag(createdCell.slot) : null;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            source_asset_id: asset_id,
            new_asset_id: newAssetId,
            kind: sourceArtifact.value.kind,
            ...(createdCell && notebook_id
              ? {
                  notebook_id,
                  cell_id: createdCell.id,
                  address,
                  message: `Duplicated as ${address}`,
                }
              : { message: "Asset duplicated" }),
          }),
        }],
      };
    },
  };
}
