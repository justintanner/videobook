import type { Engine, NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { z } from "zod";
import { resolveNotebookArtifactReference } from "./notebook-reference-resolver.js";
import type { ToolDef } from "./tools/tool-def.js";

/**
 * Actions the chat router and the voice copilot can pick that change what is
 * on screen, not the book. They are deliberately not MCP tools: a server
 * handler cannot open a viewer, so the routed plan goes back to the app, which
 * opens the view itself.
 */
type ChatViewAction = Pick<ToolDef, "name" | "description" | "schema">;

type ChatViewResolution =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; message: string };

const SHOW_MEDIA_FULLSCREEN = "show_media_fullscreen";
const FULLSCREEN_MEDIA_KINDS: readonly string[] = ["image", "video", "final"];

const CHAT_VIEW_ACTIONS: readonly ChatViewAction[] = [
  {
    name: SHOW_MEDIA_FULLSCREEN,
    description: "Show, open, view or enlarge one notebook cell's image or video in the fullscreen viewer. Changes nothing in the book",
    schema: {
      asset_id: z.string().min(1).describe("Artifact ID or grid address of the cell's image or video"),
    },
  },
];

function resolveMediaFullscreen(
  engine: Engine,
  notebook: NotebookDocument | null,
  reference: string,
): ChatViewResolution {
  if (!notebook) return { ok: false, message: "Open a notebook before showing media fullscreen" };
  const resolved = resolveNotebookArtifactReference({ engine, documents: [notebook], reference });
  if ("code" in resolved) return { ok: false, message: resolved.message };
  const cell = notebook.cells.find((candidate) => resolved.cellId
    ? candidate.id === resolved.cellId
    : resolveNotebookCellArtifactId(notebook, candidate) === resolved.artifactId);
  if (!cell) return { ok: false, message: `No cell in this notebook holds ${resolved.mention}` };
  const artifact = engine.artifacts.get(resolved.artifactId);
  if (!artifact.ok) return { ok: false, message: artifact.error.message };
  if (!FULLSCREEN_MEDIA_KINDS.includes(artifact.value.kind)) {
    return {
      ok: false,
      message: `${notebookGridTag(cell.slot)} holds ${artifact.value.kind}; fullscreen shows images and video`,
    };
  }
  return { ok: true, params: { asset_id: resolved.artifactId, cell_id: cell.id } };
}

/** Validate a routed view action and pin it to the cell the app should open. */
function resolveChatViewAction(
  engine: Engine,
  notebook: NotebookDocument | null,
  tool: string,
  params: Record<string, unknown>,
): ChatViewResolution {
  const action = CHAT_VIEW_ACTIONS.find((candidate) => candidate.name === tool);
  if (!action) return { ok: false, message: `Unknown view action: ${tool}` };
  const parsed = z.object(action.schema).safeParse(params);
  if (!parsed.success) {
    return { ok: false, message: `Invalid parameters for ${tool}: ${z.prettifyError(parsed.error)}` };
  }
  return resolveMediaFullscreen(engine, notebook, String(parsed.data.asset_id));
}

export { CHAT_VIEW_ACTIONS, resolveChatViewAction };
