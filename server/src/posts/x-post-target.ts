import type { Engine, NotebookCell } from "videobook-engine";
import { createPost, getPost, updatePost } from "./post-store.js";

export async function ensureXPost(engine: Engine, assetId: string | undefined, text: string | undefined, postCellId?: string) {
  if (postCellId) {
    let post = getPost(engine, postCellId);
    if (post.definition.platform !== "x") throw new Error("This Post targets another platform");
    if (!post.definition.source?.snapshotArtifactId) throw new Error("Choose a finished source clip first");
    if (assetId && ![post.definition.source.artifactId, post.definition.source.snapshotArtifactId, post.runtime.outbound?.artifactId].includes(assetId)) throw new Error("Asset does not match the Post source");
    if (text !== undefined && text !== post.definition.caption && text !== post.runtime.xRequest?.text) post = await updatePost(engine, postCellId, { caption: text });
    return post;
  }
  if (!assetId) throw new Error("Provide asset_id or post_cell_id");
  let source: NotebookCell | undefined;
  let notebookId: string | undefined;
  for (const item of engine.notebooks.list()) {
    const read = engine.notebooks.read(item.id);
    if (!read.ok) continue;
    source = read.value.cells.find((cell) => cell.outputArtifactId === assetId && cell.type !== "post" && cell.inputs?.sourceOperation !== "post_to_x");
    if (source) { notebookId = item.id; break; }
  }
  if (!source || !notebookId) {
    const artifact = engine.artifacts.get(assetId);
    if (!artifact.ok || !["image", "video", "final"].includes(artifact.value.kind)) throw new Error("Post source must be an image or video");
    const created = await engine.notebooks.create("Publications");
    if (!created.ok) throw new Error(created.error.message);
    notebookId = created.value.id;
    source = engine.notebooks.createCell({ type: artifact.value.kind === "image" ? "image" : "video", slot: { row: 0, column: 0 }, outputArtifactId: assetId, label: artifact.value.label });
    const written = await engine.notebooks.write({ ...created.value, cells: [source], edges: [] }, { operation: "create_post_source" });
    if (!written.ok) throw new Error(written.error.message);
  }
  return createPost(engine, { notebookId, sourceCellId: source.id, platform: "x", caption: text });
}
