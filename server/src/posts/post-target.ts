import type { Engine } from "videobook-engine";
import { createPost, getPost, updatePost } from "./post-store.js";
import type { PostPlatform, PostView } from "./post-contract.js";

export interface NewPostArgs {
  assetId?: string;
  notebookId?: string;
  sourceCellId?: string;
  platform?: PostPlatform;
  caption?: string;
}

type PostPlacement = { notebookId: string; sourceCellId?: string };

function notebookWithCell(engine: Engine, cellId: string): string {
  for (const item of engine.notebooks.list()) {
    const read = engine.notebooks.read(item.id);
    if (read.ok && read.value.cells.some((cell) => cell.id === cellId)) return item.id;
  }
  throw new Error("Source cell not found");
}

function canvasSource(engine: Engine, assetId: string): PostPlacement | null {
  for (const item of engine.notebooks.list()) {
    const read = engine.notebooks.read(item.id);
    if (!read.ok) continue;
    const source = read.value.cells.find((cell) => cell.outputArtifactId === assetId && cell.type !== "post" && cell.inputs?.sourceOperation !== "post_to_x");
    if (source) return { notebookId: item.id, sourceCellId: source.id };
  }
  return null;
}

async function publicationSource(engine: Engine, assetId: string): Promise<PostPlacement> {
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok || !["image", "video", "final"].includes(artifact.value.kind)) throw new Error("Post source must be an image or video");
  const created = await engine.notebooks.create("Publications");
  if (!created.ok) throw new Error(created.error.message);
  const source = engine.notebooks.createCell({ type: artifact.value.kind === "image" ? "image" : "video", slot: { row: 0, column: 0 }, outputArtifactId: assetId, label: artifact.value.label });
  const written = await engine.notebooks.write({ ...created.value, cells: [source], edges: [] }, { operation: "create_post_source" });
  if (!written.ok) throw new Error(written.error.message);
  return { notebookId: created.value.id, sourceCellId: source.id };
}

async function newPostPlacement(engine: Engine, args: NewPostArgs): Promise<PostPlacement> {
  if (args.sourceCellId) return { notebookId: args.notebookId ?? notebookWithCell(engine, args.sourceCellId), sourceCellId: args.sourceCellId };
  if (args.assetId) return canvasSource(engine, args.assetId) ?? publicationSource(engine, args.assetId);
  if (args.notebookId) return { notebookId: args.notebookId };
  throw new Error("Provide asset_id, source_cell_id or post_cell_id");
}

export async function createPostFor(engine: Engine, args: NewPostArgs): Promise<PostView> {
  const placement = await newPostPlacement(engine, args);
  return createPost(engine, { ...placement, platform: args.platform, caption: args.caption });
}

function postLocked(post: PostView): boolean {
  return Boolean(post.runtime.outbound || post.runtime.url || post.runtime.status === "scheduled");
}

async function existingXPost(engine: Engine, assetId: string | undefined, text: string | undefined, postCellId: string): Promise<PostView> {
  let post = getPost(engine, postCellId);
  if (post.definition.platform !== "x") {
    if (postLocked(post)) throw new Error(`This Post was delivered for ${post.definition.platform}. Post the clip to X as a new Post.`);
    post = await updatePost(engine, postCellId, { platform: "x" });
  }
  if (!post.definition.source?.snapshotArtifactId) throw new Error("Choose a finished source clip first");
  if (assetId && ![post.definition.source.artifactId, post.definition.source.snapshotArtifactId, post.runtime.outbound?.artifactId].includes(assetId)) throw new Error("Asset does not match the Post source");
  if (text !== undefined && text !== post.definition.caption && text !== post.runtime.xRequest?.text) post = await updatePost(engine, postCellId, { caption: text });
  return post;
}

export async function ensureXPost(engine: Engine, assetId: string | undefined, text: string | undefined, postCellId?: string): Promise<PostView> {
  if (postCellId) return existingXPost(engine, assetId, text, postCellId);
  if (!assetId) throw new Error("Provide asset_id or post_cell_id");
  return createPostFor(engine, { assetId, platform: "x", caption: text });
}
