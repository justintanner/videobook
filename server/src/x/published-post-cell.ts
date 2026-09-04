import type { Engine, NotebookCell } from "videobook-engine";
import {
  nextHorizontalSlotFrom,
  notebookGridTag,
} from "videobook-engine/notebook-grid";
import { mutateNotebook } from "../notebook-mutations.js";
import { slotRight } from "../notebook-placement.js";
import {
  PUBLISHED_POST_SOURCE_OPERATION,
  PUBLISHED_POST_TARGET_INPUT,
  sourceCellForPostedArtifact,
} from "../notebook-published-post.js";
import type { PostToXResult } from "./post-contract.js";

function publishedCellType(source: NotebookCell): "image" | "video" {
  if (source.type === "image" || source.type === "video") return source.type;
  return "video";
}

function publishedPostInputs(
  posted: PostToXResult,
  sourceCellId: string,
): Record<string, unknown> {
  return {
    sourceOperation: PUBLISHED_POST_SOURCE_OPERATION,
    platform: "x",
    tweetId: posted.tweet_id,
    tweetUrl: posted.tweet_url,
    postedAt: posted.posted_at,
    status: posted.status,
    replies: posted.replies.map((reply) => ({
      tweetId: reply.tweet_id,
      tweetUrl: reply.tweet_url,
    })),
    sourceCellId,
    ...(posted.followup_error
      ? {
          followupError: {
            replyNumber: posted.followup_error.reply_number,
            message: posted.followup_error.message,
          },
        }
      : {}),
  };
}

function locatePublishedPostAnchor(
  engine: Engine,
  artifactId: string,
): { notebookId: string; source: NotebookCell } | null {
  for (const listed of engine.notebooks.list()) {
    const read = engine.notebooks.read(listed.id);
    if (!read.ok) continue;
    const source = sourceCellForPostedArtifact(read.value, artifactId);
    if (source) return { notebookId: listed.id, source };
  }
  return null;
}

export async function createPublishedPostCell(args: {
  engine: Engine;
  assetId: string;
  posted: PostToXResult;
}): Promise<{ cellId: string; cellAddress: string } | null> {
  const located = locatePublishedPostAnchor(args.engine, args.assetId);
  if (!located) return null;
  const placement: { cell: NotebookCell | null } = { cell: null };
  const written = await mutateNotebook(
    args.engine,
    located.notebookId,
    "post_to_x",
    (notebook) => {
      const anchor = notebook.cells.find((cell) => cell.id === located.source.id)
        ?? sourceCellForPostedArtifact(notebook, args.assetId);
      if (!anchor) {
        throw new Error(`Source cell not found for posted asset ${args.assetId}`);
      }
      const occupied = notebook.cells.map((cell) => cell.slot);
      const slot = nextHorizontalSlotFrom(slotRight(anchor.slot), occupied);
      const cell = args.engine.notebooks.createCell({
        type: publishedCellType(anchor),
        label: "Posted to X",
        slot,
        inputs: publishedPostInputs(args.posted, anchor.id),
        outputArtifactId: args.assetId,
      });
      const edge = args.engine.notebooks.createEdge({
        source: anchor.id,
        target: cell.id,
        targetInput: PUBLISHED_POST_TARGET_INPUT,
      });
      placement.cell = cell;
      return {
        ...notebook,
        cells: [...notebook.cells, cell],
        edges: [...notebook.edges, edge],
      };
    },
    {
      sourceCellId: located.source.id,
      tweetId: args.posted.tweet_id,
      status: args.posted.status,
    },
  );
  if (!written.ok) throw new Error(written.error.message);
  const cell = placement.cell;
  if (!cell) throw new Error("Published post cell was not created");
  return {
    cellId: cell.id,
    cellAddress: notebookGridTag(cell.slot),
  };
}
