import type {
  Engine,
  EntityDocument,
  EntityType,
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from "videobook-engine";
import { z } from "zod";
import type { BookManager } from "../book-manager.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { queue, stopBookQueue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const bookSchema = { book_id: z.string().uuid() };
const cellTypeSchema = z.enum([
  "prompt",
  "character",
  "scene",
  "asset",
  "image",
  "video",
]);
const cellInputSchema = z.object({
  type: cellTypeSchema,
  title: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  entity_id: z.string().uuid().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  output_artifact_id: z.string().uuid().optional(),
});

type CellInput = z.infer<typeof cellInputSchema>;

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function cellFromInput(input: CellInput): Omit<NotebookCell, "id"> {
  return {
    type: input.type,
    title: input.title,
    position: input.position,
    ...(input.entity_id ? { entityId: input.entity_id } : {}),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
    ...(input.output_artifact_id ? { outputArtifactId: input.output_artifact_id } : {}),
  };
}

function cellPayload(cell: NotebookCell): Record<string, unknown> {
  return {
    id: cell.id,
    type: cell.type,
    title: cell.title,
    position: cell.position,
    ...(cell.entityId ? { entity_id: cell.entityId } : {}),
    ...(cell.prompt === undefined ? {} : { prompt: cell.prompt }),
    ...(cell.model === undefined ? {} : { model: cell.model }),
    ...(cell.inputs === undefined ? {} : { inputs: cell.inputs }),
    ...(cell.outputArtifactId ? { output_artifact_id: cell.outputArtifactId } : {}),
  };
}

function notebookPayload(notebook: NotebookDocument): Record<string, unknown> {
  return {
    id: notebook.id,
    name: notebook.name,
    created_at: notebook.createdAt,
    properties: notebook.properties ?? {},
    cells: notebook.cells.map(cellPayload),
    edges: notebook.edges,
  };
}

function entityDefs(engine: Engine, type: EntityType): ToolDef[] {
  const plural = type === "character" ? "characters" : `${type}s`;
  return [
    {
      name: `create_${type}_entity`,
      description: `Create a reusable ${type}`,
      scope: "book",
      schema: {
        ...bookSchema,
        name: z.string().min(1),
        description: z.string().optional(),
        prompt: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      },
      handler: async (args) => {
        const result = await engine.entities.create(type, String(args.name), {
          ...(typeof args.description === "string" ? { description: args.description } : {}),
          ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
          data: args.data as Record<string, unknown> | undefined,
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `list_${plural}`,
      description: `List reusable ${plural}`,
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.entities.list(type)),
    },
    {
      name: `get_${type}_entity`,
      description: `Read a reusable ${type}`,
      scope: "book",
      schema: { ...bookSchema, entity_id: z.string().uuid() },
      handler: async (args) => {
        const result = engine.entities.read(String(args.entity_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `update_${type}_entity`,
      description: `Update a reusable ${type}`,
      scope: "book",
      schema: { ...bookSchema, entity: z.record(z.string(), z.unknown()) },
      handler: async (args) => {
        const result = await engine.entities.write(args.entity as unknown as EntityDocument);
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `delete_${type}_entity`,
      description: `Delete a reusable ${type}`,
      scope: "book",
      schema: { ...bookSchema, entity_id: z.string().uuid() },
      handler: async (args) => {
        const result = await engine.entities.delete(String(args.entity_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
  ];
}

export function videobookDomainDefs(
  engine: Engine,
  books: BookManager,
): ToolDef[] {
  return [
    {
      name: "list_books",
      description: "List all Videobook books",
      scope: "global",
      schema: { sort: z.enum(["newest", "oldest"]).optional() },
      handler: async (args) => {
        await books.ready();
        return json(books.list({
          ...(args.sort === "newest" || args.sort === "oldest" ? { sort: args.sort } : {}),
        }));
      },
    },
    {
      name: "create_book",
      description: "Create a book with a Main notebook",
      scope: "global",
      schema: { slug: z.string().min(1) },
      handler: async (args) => {
        const result = await books.create(String(args.slug));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "rename_book",
      description: "Rename a book",
      scope: "global",
      schema: { ...bookSchema, slug: z.string().min(1) },
      handler: async (args) => {
        const result = await books.rename(String(args.book_id), String(args.slug));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "delete_book",
      description: "Permanently delete a book after typed slug confirmation",
      scope: "global",
      schema: { ...bookSchema, confirm_slug: z.string().min(1) },
      handler: async (args) => {
        const result = await books.delete(String(args.book_id), {
          confirmSlug: String(args.confirm_slug),
          beforeDelete: async (book) => stopBookQueue(book.bookId),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "get_book",
      description: "Read the current book identity",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.book.get()),
    },
    {
      name: "list_notebooks",
      description: "List v2 notebook documents",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.notebooks.list().map(notebookPayload)),
    },
    {
      name: "create_notebook",
      description: "Create an empty notebook",
      scope: "book",
      schema: { ...bookSchema, name: z.string().min(1) },
      handler: async (args) => {
        const result = await engine.notebooks.create(String(args.name));
        return result.ok ? json(notebookPayload(result.value)) : failure(result.error.message);
      },
    },
    {
      name: "get_notebook",
      description: "Read a notebook graph",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid() },
      handler: async (args) => {
        const result = engine.notebooks.read(String(args.notebook_id));
        return result.ok ? json(notebookPayload(result.value)) : failure(result.error.message);
      },
    },
    {
      name: "rename_notebook",
      description: "Rename a notebook",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), name: z.string().min(1) },
      handler: async (args) => {
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "rename_notebook",
          (notebook) => ({ ...notebook, name: String(args.name) }),
        );
        return result.ok ? json({ notebook_id: args.notebook_id, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "delete_notebook",
      description: "Delete a notebook and its cells, edges, and runs",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid() },
      handler: async (args) => {
        const result = await engine.notebooks.delete(String(args.notebook_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "create_notebook_cell",
      description: "Create a UUIDv7 notebook cell",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), cell: cellInputSchema },
      handler: async (args) => {
        const cell = engine.notebooks.createCell(cellFromInput(args.cell as CellInput));
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "create_notebook_cell",
          (notebook) => ({ ...notebook, cells: [...notebook.cells, cell] }),
          { cellId: cell.id },
        );
        return result.ok ? json(cellPayload(cell)) : failure(result.error.message);
      },
    },
    {
      name: "update_notebook_cell",
      description: "Update one notebook cell",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        cell: cellInputSchema.partial(),
      },
      handler: async (args) => {
        const patch = args.cell as Partial<CellInput>;
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "update_notebook_cell",
          (notebook) => {
            let found = false;
            const cells = notebook.cells.map((cell) => {
              if (cell.id !== args.cell_id) return cell;
              found = true;
              return {
                ...cell,
                ...(patch.type ? { type: patch.type as NotebookCellType } : {}),
                ...(patch.title === undefined ? {} : { title: patch.title }),
                ...(patch.position === undefined ? {} : { position: patch.position }),
                ...(patch.entity_id === undefined ? {} : { entityId: patch.entity_id }),
                ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
                ...(patch.model === undefined ? {} : { model: patch.model }),
                ...(patch.inputs === undefined ? {} : { inputs: patch.inputs }),
                ...(patch.output_artifact_id === undefined ? {} : { outputArtifactId: patch.output_artifact_id }),
              };
            });
            if (!found) throw new Error(`Cell not found: ${String(args.cell_id)}`);
            return { ...notebook, cells };
          },
          { cellId: args.cell_id },
        );
        return result.ok ? json({ cell_id: args.cell_id, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "move_notebook_cells",
      description: "Persist notebook cell positions",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        positions: z.array(z.object({ id: z.string().uuid(), x: z.number(), y: z.number() })).min(1),
      },
      handler: async (args) => {
        const positions = new Map((args.positions as Array<{ id: string; x: number; y: number }>).map((position) => [position.id, position]));
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "move_notebook_cells",
          (notebook) => ({
            ...notebook,
            cells: notebook.cells.map((cell) => {
              const position = positions.get(cell.id);
              return position ? { ...cell, position: { x: position.x, y: position.y } } : cell;
            }),
          }),
          { cellIds: [...positions.keys()] },
        );
        return result.ok ? json({ notebook_id: args.notebook_id, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "delete_notebook_cell",
      description: "Delete one notebook cell and incident edges",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), cell_id: z.string().uuid() },
      handler: async (args) => {
        const cellId = String(args.cell_id);
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "delete_notebook_cell",
          (notebook) => ({
            ...notebook,
            cells: notebook.cells.filter((cell) => cell.id !== cellId),
            edges: notebook.edges.filter((edge) => edge.source !== cellId && edge.target !== cellId),
          }),
          { cellId },
        );
        return result.ok ? json({ cell_id: cellId, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "connect_notebook_cells",
      description: "Create a UUIDv7 notebook edge",
      scope: "book",
      schema: {
        ...bookSchema,
        notebook_id: z.string().uuid(),
        source_cell_id: z.string().uuid(),
        target_cell_id: z.string().uuid(),
        target_input: z.string().min(1),
      },
      handler: async (args) => {
        const edge = engine.notebooks.createEdge({
          source: String(args.source_cell_id),
          target: String(args.target_cell_id),
          targetInput: String(args.target_input),
        });
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "connect_notebook_cells",
          (notebook) => ({ ...notebook, edges: [...notebook.edges, edge] }),
          { sourceCellId: edge.source, targetCellId: edge.target, edgeId: edge.id },
        );
        return result.ok ? json(edge) : failure(result.error.message);
      },
    },
    {
      name: "disconnect_notebook_cells",
      description: "Delete a notebook edge",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), edge_id: z.string().uuid() },
      handler: async (args) => {
        const edgeId = String(args.edge_id);
        const result = await mutateNotebook(
          engine,
          String(args.notebook_id),
          "disconnect_notebook_cells",
          (notebook) => ({ ...notebook, edges: notebook.edges.filter((edge) => edge.id !== edgeId) }),
          { edgeId },
        );
        return result.ok ? json({ edge_id: edgeId, revision: result.value.hash }) : failure(result.error.message);
      },
    },
    {
      name: "run_notebook_cell",
      description: "Run a selected image or video notebook cell",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid(), cell_id: z.string().uuid() },
      handler: async (args) => {
        const jobId = `run-notebook-${String(args.notebook_id)}-${String(args.cell_id)}-${Date.now()}`;
        await queue.enqueue(jobId, {
          type: "run_notebook",
          bookId: String(args.book_id),
          notebookId: String(args.notebook_id),
          cellIds: [String(args.cell_id)],
          force: true,
        });
        return json({ job_id: jobId });
      },
    },
    {
      name: "run_notebook",
      description: "Run missing or stale image and video cells topologically",
      scope: "book",
      schema: { ...bookSchema, notebook_id: z.string().uuid() },
      handler: async (args) => {
        const jobId = `run-notebook-${String(args.notebook_id)}-${Date.now()}`;
        await queue.enqueue(jobId, {
          type: "run_notebook",
          bookId: String(args.book_id),
          notebookId: String(args.notebook_id),
          force: false,
        });
        return json({ job_id: jobId });
      },
    },
    {
      name: "list_jobs",
      description: "List persistent jobs for a book",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.jobs.queue.list()),
    },
    {
      name: "list_book_actions",
      description: "List permanent action history for a book",
      scope: "book",
      schema: { ...bookSchema, limit: z.number().int().positive().max(10_000).optional(), cursor: z.string().optional() },
      handler: async (args) => {
        const result = engine.history.actions({
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "get_history_action",
      description: "Read one action history record",
      scope: "book",
      schema: { ...bookSchema, action_id: z.string().uuid() },
      handler: async (args) => {
        const result = engine.history.action(String(args.action_id));
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "storage_status",
      description: "Read v2 catalog and object publication status",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(engine.storage.status()),
    },
    {
      name: "storage_sync",
      description: "Publish a book's pending content-addressed objects and catalog",
      scope: "book",
      schema: bookSchema,
      handler: async () => json(await engine.storage.backup()),
    },
    ...entityDefs(engine, "prompt"),
    ...entityDefs(engine, "scene"),
    ...entityDefs(engine, "character"),
  ];
}
