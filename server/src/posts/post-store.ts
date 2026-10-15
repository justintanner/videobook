import { createHash } from "node:crypto";
import { extname } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { findPrimaryMediaFile } from "videobook-engine";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { nextHorizontalSlotFrom, notebookGridTag, notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import { mutateNotebook, withNotebookMutation } from "../notebook-mutations.js";
import { slotRight } from "../notebook-placement.js";
import type { PostDefinition, PostPlatform, PostRuntime, PostView } from "./post-contract.js";

const key = (id: string) => `application.post.v1.${id}`;

export function readPostRuntime(engine: Engine, id: string): PostRuntime {
  return engine.settings.get<PostRuntime>(key(id)) ?? { status: "draft", metrics: [] };
}

export function patchPostRuntime(engine: Engine, id: string, patch: Partial<PostRuntime>): PostRuntime {
  const next = { ...readPostRuntime(engine, id), ...patch };
  const ids = engine.settings.get<string[]>("application.posts.index.v1") ?? [];
  if (!ids.includes(id)) {
    const indexed = engine.settings.set("application.posts.index.v1", [...ids, id]);
    if (!indexed.ok) throw new Error(indexed.error.message);
  }
  const written = engine.settings.set(key(id), next);
  if (!written.ok) throw new Error(written.error.message);
  return next;
}

function postDefinition(cell: NotebookCell): PostDefinition {
  const value = cell.inputs?.post as PostDefinition | undefined;
  if (!value || value.version !== 1) throw new Error("Post needs migration before editing");
  return value;
}

export function notebookPosts(engine: Engine, notebook: NotebookDocument): PostView[] {
  return notebook.cells.filter((cell) => cell.type === "post" && cell.inputs?.post).map((cell) => {
    const definition = postDefinition(cell);
    const runtime = readPostRuntime(engine, cell.id);
    return {
      id: cell.id, notebookId: notebook.id, address: notebookGridTag(cell.slot), label: cell.label ?? "Post",
      definition: runtime.publication ? { ...runtime.publication, notes: definition.notes } : definition, runtime,
    };
  });
}

export function listPosts(engine: Engine): PostView[] {
  return engine.notebooks.list().flatMap((item) => {
    const read = engine.notebooks.read(item.id);
    return read.ok ? notebookPosts(engine, read.value) : [];
  });
}

export function getPost(engine: Engine, id: string): PostView {
  const post = listPosts(engine).find((item) => item.id === id);
  if (!post) throw new Error(`Post cell ${id} not found`);
  return post;
}

function captureLineage(notebook: NotebookDocument, source: NotebookCell): PostDefinition["lineage"] {
  const seen = new Set<string>();
  const visit = (cell: NotebookCell): void => {
    if (seen.has(cell.id)) return;
    seen.add(cell.id);
    for (const edge of notebook.edges.filter((item) => item.target === cell.id)) {
      const parent = notebook.cells.find((item) => item.id === edge.source);
      if (parent) visit(parent);
    }
    for (const name of ["producerCellId", "sourceCellId"]) {
      const parent = notebook.cells.find((item) => item.id === cell.inputs?.[name]);
      if (parent) visit(parent);
    }
    if (typeof cell.inputs?.goalId === "string") {
      const goal = notebook.cells.find((item) => item.type === "goal" && item.inputs?.goalId === cell.inputs?.goalId);
      if (goal) visit(goal);
    }
    const artifactIds = ["sourceArtifactId", "source_asset_id", "first_asset_id", "second_asset_id", "additional_asset_ids", "sourceArtifactIds", "image_asset_ids"].flatMap((name) => {
      const value = cell.inputs?.[name];
      return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    });
    for (const artifactId of artifactIds) {
      const parent = notebook.cells.find((item) => item.outputArtifactId === artifactId && item.type !== "post");
      if (parent) visit(parent);
    }
  };
  visit(source);
  return notebook.cells.filter((cell) => seen.has(cell.id)).map((cell) => ({
    cellId: cell.id, type: cell.type, label: cell.label, artifactId: cell.outputArtifactId,
    prompt: cell.prompt, inputs: cell.inputs,
  }));
}

async function freezeSource(engine: Engine, source: NotebookCell): Promise<NonNullable<PostDefinition["source"]>> {
  const artifactId = source.outputArtifactId;
  if (!artifactId) throw new Error("Choose a finished image or video cell");
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok || !["video", "image", "final"].includes(artifact.value.kind)) throw new Error("A Post needs an image or video source");
  const revision = engine.head;
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
  if (!file) throw new Error("Source has no finished media file");
  const bytes = await engine.files.readAtRevision(artifactId, file.name, revision);
  if (!bytes.ok) throw new Error(bytes.error.message);
  const snapshot = await engine.artifacts.create(artifact.value.kind === "final" ? "video" : artifact.value.kind, `Post source · ${source.label ?? artifact.value.label ?? "clip"}`);
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const snapshotArtifactId = snapshot.value.artifactId;
  const filename = `original${extname(file.name)}`;
  const written = await engine.files.write(snapshotArtifactId, filename, bytes.value);
  if (!written.ok) throw new Error(written.error.message);
  const tagged = await engine.metadata.artifacts.write(snapshotArtifactId, "publication", { role: "source-snapshot", sourceArtifactId: artifactId, sourceRevision: revision });
  if (!tagged.ok) throw new Error(tagged.error.message);
  return { cellId: source.id, artifactId, revision, objectHash: createHash("sha256").update(bytes.value).digest("hex"), filename, sourceFilename: file.name, snapshotArtifactId };
}

export async function createPost(engine: Engine, args: {
  notebookId: string; sourceCellId?: string; platform?: PostPlatform; caption?: string; credits?: string; account?: string; notes?: string;
}): Promise<PostView> {
  let createdId = "";
  await withNotebookMutation(args.notebookId, async () => {
    const read = engine.notebooks.read(args.notebookId);
    if (!read.ok) throw new Error(read.error.message);
    const notebook = read.value;
    const source = args.sourceCellId ? notebook.cells.find((cell) => cell.id === args.sourceCellId && cell.type !== "post") : undefined;
    if (args.sourceCellId && !source) throw new Error("Source cell not found");
    const frozen = source ? await freezeSource(engine, source) : null;
    const definition: PostDefinition = {
      version: 1, platform: args.platform ?? "x", caption: args.caption ?? "", credits: args.credits ?? "", account: args.account ?? "", notes: args.notes ?? "",
      createdAt: new Date().toISOString(), source: frozen, lineage: source ? captureLineage(notebook, source) : [],
    };
    const cell = engine.notebooks.createCell({
      type: "post", label: `Post · ${definition.platform}`,
      slot: nextHorizontalSlotFrom(source ? slotRight(source.slot) : { row: 0, column: 0 }, notebookOccupiedSlots(notebook.cells)),
      inputs: { post: definition },
      ...(frozen?.snapshotArtifactId ? { outputArtifactId: frozen.snapshotArtifactId, references: [{
        id: uuidv7(), kind: "artifact", targetId: frozen.artifactId,
        snapshot: { objectHash: frozen.objectHash, revision: frozen.revision }, ordinal: 0,
      }] } : {}),
    });
    createdId = cell.id;
    const result = await engine.notebooks.write({ ...notebook, cells: [...notebook.cells, cell], edges: source ? [...notebook.edges, engine.notebooks.createEdge({ source: source.id, target: cell.id, targetInput: "post" })] : notebook.edges }, { operation: "create_post" });
    if (!result.ok) throw new Error(result.error.message);
  });
  return getPost(engine, createdId);
}

export async function updatePost(engine: Engine, id: string, patch: Partial<Pick<PostDefinition, "platform" | "caption" | "credits" | "account" | "notes">> & { sourceCellId?: string }): Promise<PostView> {
  const post = getPost(engine, id);
  const locked = Boolean(post.runtime.outbound || post.runtime.url || post.runtime.status === "scheduled");
  if (locked && Object.keys(patch).some((name) => name !== "notes")) throw new Error("This publication is frozen. Create a new Post for a different clip, caption or platform.");
  let frozen = post.definition.source;
  let lineage = post.definition.lineage;
  if (patch.sourceCellId) {
    if (frozen) throw new Error("The source version is frozen. Create a new Post for another clip.");
    const read = engine.notebooks.read(post.notebookId);
    if (!read.ok) throw new Error(read.error.message);
    const source = read.value.cells.find((cell) => cell.id === patch.sourceCellId && cell.type !== "post");
    if (!source) throw new Error("Source cell not found");
    frozen = await freezeSource(engine, source);
    lineage = captureLineage(read.value, source);
  }
  const { sourceCellId: _source, ...fields } = patch;
  const written = await mutateNotebook(engine, post.notebookId, "update_post", (document) => ({
    ...document,
    cells: document.cells.map((cell) => cell.id !== id ? cell : {
      ...cell, label: `Post · ${fields.platform ?? post.definition.platform}`,
      inputs: { post: { ...postDefinition(cell), ...fields, source: frozen, lineage } },
      ...(frozen?.snapshotArtifactId ? { outputArtifactId: frozen.snapshotArtifactId } : {}),
    }),
    edges: patch.sourceCellId ? [...document.edges, engine.notebooks.createEdge({ source: patch.sourceCellId, target: id, targetInput: "post" })] : document.edges,
  }));
  if (!written.ok) throw new Error(written.error.message);
  return getPost(engine, id);
}

export async function freezePostOutbound(engine: Engine, id: string, media?: { bytes: Buffer; filename: string }): Promise<NonNullable<PostRuntime["outbound"]>> {
  const post = getPost(engine, id);
  if (post.runtime.outbound) return post.runtime.outbound;
  const source = post.definition.source;
  if (!source?.snapshotArtifactId || !source.filename) throw new Error("Historical media version is unknown. Create a new Post to upload a clip.");
  const artifact = engine.artifacts.get(source.snapshotArtifactId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  const created = await engine.artifacts.create(artifact.value.kind, `Publication · ${post.address}`);
  if (!created.ok) throw new Error(created.error.message);
  const artifactId = created.value.artifactId;
  const filename = media?.filename ?? source.filename;
  const copied = media ? await engine.files.write(artifactId, filename, media.bytes) : await engine.files.copy(source.snapshotArtifactId, source.filename, artifactId, filename);
  if (!copied.ok) throw new Error(copied.error.message);
  const caption = [post.definition.caption, post.definition.credits].filter(Boolean).join("\n\n");
  const written = await engine.files.write(artifactId, "caption.txt", caption);
  if (!written.ok) throw new Error(written.error.message);
  const tagged = await engine.metadata.artifacts.write(artifactId, "publication", { role: "outbound", postId: id });
  if (!tagged.ok) throw new Error(tagged.error.message);
  const result = await mutateNotebook(engine, post.notebookId, "freeze_post", (document) => ({ ...document, cells: document.cells.map((cell) => cell.id === id ? { ...cell, outputArtifactId: artifactId } : cell) }));
  if (!result.ok) throw new Error(result.error.message);
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const outbound = { artifactId, filename, caption, frozenAt: new Date().toISOString(), revision: engine.head, objectHash: manifest.value.files.find(file => file.name === filename)!.objectHash };
  patchPostRuntime(engine, id, { outbound, publication: post.definition });
  return outbound;
}

function normalizePostUrl(value: string, platform: PostPlatform): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use a public HTTPS post link");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const allowed: Record<PostPlatform, string[]> = { x: ["x.com", "twitter.com"], instagram: ["instagram.com"], tiktok: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"], youtube: ["youtube.com", "youtu.be"], other: [] };
  if (platform !== "other" && !allowed[platform].includes(host)) throw new Error(`The URL does not match ${platform}`);
  if (platform === "x") {
    const id = url.pathname.match(/\/status\/(\d+)/)?.[1];
    if (!id) throw new Error("Use an X post URL containing /status/<id>");
    return `https://x.com/i/web/status/${id}`;
  }
  url.hostname = host;
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) if (name !== "v") url.searchParams.delete(name);
  return url.toString().replace(/\/$/, "");
}

export async function linkPost(engine: Engine, id: string, url: string, postedAt: string): Promise<PostView> {
  const post = getPost(engine, id);
  if (!post.definition.source) throw new Error("Choose the source clip before linking a publication");
  const normalized = normalizePostUrl(url, post.definition.platform);
  const time = new Date(postedAt).getTime();
  if (!Number.isFinite(time) || time > Date.now() + 60_000) throw new Error("Enter the actual publication time");
  const duplicate = () => (engine.settings.get<string[]>("application.posts.index.v1") ?? []).some((otherId) => otherId !== id && readPostRuntime(engine, otherId).url === normalized);
  if (duplicate()) throw new Error("That publication is already tracked by another Post cell");
  if (post.runtime.url && post.runtime.url !== normalized) throw new Error("This Post already represents a publication. Create a new Post for a repost.");
  if (post.runtime.url) return post;
  await freezePostOutbound(engine, id);
  if (duplicate()) throw new Error("That publication is already tracked by another Post cell");
  patchPostRuntime(engine, id, { url: normalized, postedAt: new Date(time).toISOString(), status: "posted", error: null, nextMetricAt: post.definition.platform === "x" ? new Date().toISOString() : null, metricsPaused: false });
  return getPost(engine, id);
}

function legacyXReceipt(inputs: Record<string, unknown>): NonNullable<PostRuntime["x"]> {
  const replies = (Array.isArray(inputs.replies) ? inputs.replies : []).flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const reply = value as Record<string, unknown>;
    const id = reply.tweet_id ?? reply.tweetId;
    const url = reply.tweet_url ?? reply.tweetUrl;
    if (typeof id !== "string" || typeof url !== "string") return [];
    return [{ tweet_id: id, tweet_url: url, media_ids: Array.isArray(reply.media_ids) ? reply.media_ids.filter((id): id is string => typeof id === "string") : [], text: typeof reply.text === "string" ? reply.text : null, posted_at: typeof reply.posted_at === "string" ? reply.posted_at : "" }];
  });
  const error = inputs.followupError && typeof inputs.followupError === "object" ? inputs.followupError as Record<string, unknown> : null;
  return { tweetId: String(inputs.tweetId ?? ""), mediaId: "", replies, followupError: error ? { reply_number: Number(error.reply_number ?? error.replyNumber), message: String(error.message ?? "Reply failed") } : null };
}

function migrateLegacyNotebook(engine: Engine, notebook: NotebookDocument): NotebookDocument {
  const legacy = notebook.cells.filter(cell => cell.inputs?.sourceOperation === "post_to_x" && !cell.inputs.post);
  const ids = new Set(legacy.map(cell => cell.id));
  const cells = [...notebook.cells];
  const parents = new Map<string, NotebookCell>();
  for (const cell of legacy) {
    let source = cells.find(item => item.id === cell.inputs?.sourceCellId && !ids.has(item.id))
      ?? cells.find(item => item.outputArtifactId === cell.outputArtifactId && !ids.has(item.id) && ["image", "video", "generate_image", "generate_video", "concat", "splice", "split_video"].includes(item.type));
    if (!source && notebook.edges.some(edge => edge.source === cell.id)) {
      source = engine.notebooks.createCell({ type: cell.type === "image" ? "image" : "video", label: "Historical post source", outputArtifactId: cell.outputArtifactId, slot: nextHorizontalSlotFrom(slotRight(cell.slot), notebookOccupiedSlots(cells)) });
      cells.push(source);
    }
    if (source) parents.set(cell.id, source);
  }
  const edges = notebook.edges.map(edge => ids.has(edge.source) ? { ...edge, source: parents.get(edge.source)!.id } : edge);
  for (const cell of legacy) {
    const source = parents.get(cell.id);
    if (source && !edges.some(edge => edge.target === cell.id)) edges.push(engine.notebooks.createEdge({ source: source.id, target: cell.id, targetInput: "post" }));
  }
  return { ...notebook, edges, cells: cells.map(cell => {
    if (!ids.has(cell.id)) return cell;
    const source = parents.get(cell.id);
    const definition: PostDefinition = {
      version: 1, platform: "x", account: "", caption: "", credits: "", notes: "Historical media version is unknown.",
      createdAt: String(cell.inputs?.postedAt ?? new Date().toISOString()),
      source: { cellId: source?.id ?? String(cell.inputs?.sourceCellId ?? ""), artifactId: cell.outputArtifactId ?? "", revision: null, objectHash: null, filename: null, snapshotArtifactId: null },
      lineage: source ? captureLineage({ ...notebook, cells }, source) : [],
    };
    return { ...cell, type: "post", inputs: { post: definition } };
  }) };
}

export async function migrateLegacyPosts(engine: Engine): Promise<void> {
  for (const item of engine.notebooks.list()) {
    const read = engine.notebooks.read(item.id);
    if (!read.ok) continue;
    const legacy = read.value.cells.filter((cell) => cell.inputs?.sourceOperation === "post_to_x" && !cell.inputs.post);
    if (!legacy.length) continue;
    for (const cell of legacy) {
      const inputs = cell.inputs ?? {};
      if (readPostRuntime(engine, cell.id).url) continue;
      patchPostRuntime(engine, cell.id, {
        status: inputs.status === "partially_posted" ? "partially_posted" : "posted",
        url: typeof inputs.tweetUrl === "string" ? inputs.tweetUrl : undefined,
        postedAt: typeof inputs.postedAt === "string" ? inputs.postedAt : undefined,
        x: legacyXReceipt(inputs),
        nextMetricAt: new Date().toISOString(),
      });
    }
    const result = await mutateNotebook(engine, item.id, "migrate_post_cells", (notebook) => migrateLegacyNotebook(engine, notebook));
    if (!result.ok) throw new Error(result.error.message);
    for (const cell of legacy) {
      const post = getPost(engine, cell.id);
      if (!post.runtime.publication) patchPostRuntime(engine, cell.id, { publication: post.definition });
    }
  }
}
