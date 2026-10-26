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
const SHOW_SUBTITLES = "show_subtitles";
const FULLSCREEN_MEDIA_KINDS: readonly string[] = ["image", "video", "final"];
const SUBTITLE_MEDIA_KINDS: readonly string[] = ["video", "final"];

const CHAT_VIEW_ACTIONS: readonly ChatViewAction[] = [
  {
    name: SHOW_MEDIA_FULLSCREEN,
    description: "Show, open, view or enlarge one notebook cell's image or video in the fullscreen viewer. Changes nothing in the book",
    schema: {
      asset_id: z.string().min(1).describe("Artifact ID or grid address of the cell's image or video"),
    },
  },
  {
    name: SHOW_SUBTITLES,
    description: "Open the subtitle editor for one notebook video to add, review, correct, style, position or render TikTok-style subtitles and captions (karaoke word highlighting). Changes nothing until the user renders",
    schema: {
      asset_id: z.string().min(1).describe("Artifact ID or grid address of the cell's video"),
    },
  },
];

function resolveCellMedia(
  engine: Engine,
  notebook: NotebookDocument | null,
  reference: string,
  kinds: readonly string[],
  kindMessage: string,
): ChatViewResolution {
  if (!notebook) return { ok: false, message: "Open a notebook first" };
  const resolved = resolveNotebookArtifactReference({ engine, documents: [notebook], reference });
  if ("code" in resolved) return { ok: false, message: resolved.message };
  const cell = notebook.cells.find((candidate) => resolved.cellId
    ? candidate.id === resolved.cellId
    : resolveNotebookCellArtifactId(notebook, candidate) === resolved.artifactId);
  if (!cell) return { ok: false, message: `No cell in this notebook holds ${resolved.mention}` };
  const artifact = engine.artifacts.get(resolved.artifactId);
  if (!artifact.ok) return { ok: false, message: artifact.error.message };
  if (!kinds.includes(artifact.value.kind)) {
    return { ok: false, message: `${notebookGridTag(cell.slot)} holds ${artifact.value.kind}; ${kindMessage}` };
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
  return tool === SHOW_SUBTITLES
    ? resolveCellMedia(engine, notebook, String(parsed.data.asset_id), SUBTITLE_MEDIA_KINDS, "subtitles need a video")
    : resolveCellMedia(engine, notebook, String(parsed.data.asset_id), FULLSCREEN_MEDIA_KINDS, "fullscreen shows images and video");
}

export { CHAT_VIEW_ACTIONS, resolveChatViewAction };
