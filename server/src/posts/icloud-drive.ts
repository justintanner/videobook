import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { Engine } from "videobook-engine";
import { freezePostOutbound, getPost, patchPostRuntime, readPostRuntime, updatePost } from "./post-store.js";
import type { PostICloudFile, PostRuntime } from "./post-contract.js";
import { defaultPostFolderName, icloudFolderError } from "./post-folder.js";
import { readUbiquitousStates, summarizeUbiquitousSync, type ICloudSyncStatus } from "./icloud-status.js";

type ICloudRuntime = NonNullable<PostRuntime["icloud"]>;

function icloudRoot(): string {
  return process.env.VIDEOBOOK_ICLOUD_DIR || join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/Videobook");
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : -1;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function icloudUnavailableReason(root = icloudRoot()): Promise<string | null> {
  if (process.platform !== "darwin" && !process.env.VIDEOBOOK_ICLOUD_DIR) return "Saving to iCloud needs the Videobook server running on a Mac.";
  if (!await isDirectory(dirname(root))) return "iCloud Drive is not set up on this Mac. Turn on iCloud Drive in System Settings.";
  return null;
}

function insideIcloudRoot(root: string, relativePath: string): string {
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, relativePath);
  if (target !== rootResolved && !target.startsWith(`${rootResolved}${sep}`)) throw new Error("iCloud path is outside the Videobook folder.");
  return target;
}

export async function postIcloudSyncStatus(engine: Engine, id: string): Promise<ICloudSyncStatus> {
  const recorded = getPost(engine, id).runtime.icloud;
  const relative = [recorded?.video?.path, recorded?.caption?.path].filter((path): path is string => Boolean(path));
  if (relative.length === 0) return { phase: "not-icloud", error: null };
  const root = icloudRoot();
  return summarizeUbiquitousSync(await readUbiquitousStates(relative.map((path) => insideIcloudRoot(root, path))));
}

export async function icloudStatus() {
  const root = icloudRoot();
  const reason = await icloudUnavailableReason(root);
  const state = reason ? null : (await readUbiquitousStates([root]))?.[0] ?? null;
  return { available: !reason, root, shared: state?.ubiquitous ? state.shared : null, role: state?.ubiquitous ? state.role : null, reason };
}

async function applyCaption(engine: Engine, id: string, caption: string | undefined) {
  const post = getPost(engine, id);
  if (caption === undefined || caption === post.definition.caption) return post;
  if (post.runtime.outbound) throw new Error("This Post's caption was frozen at its first delivery. Create a new Post to deliver a different caption.");
  return updatePost(engine, id, { caption });
}

async function placeFile(target: string, bytes: Buffer): Promise<void> {
  const stagingDir = join(homedir(), "Library/Caches/videobook/icloud-staging");
  await mkdir(stagingDir, { recursive: true });
  const staging = join(stagingDir, randomUUID());
  await writeFile(staging, bytes);
  try {
    await rename(staging, target);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV")) throw error;
    const partial = join(dirname(target), `.${target.split("/").at(-1)}.videobook-partial`);
    await copyFile(staging, partial);
    await rename(partial, target);
  } finally {
    await rm(staging, { force: true });
  }
}

async function deliverFile(root: string, path: string, bytes: Buffer, recorded: PostICloudFile | undefined): Promise<PostICloudFile> {
  const file = { path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  const target = join(root, path);
  const existing = await fileSize(target);
  if (existing !== null) {
    if (recorded && recorded.path === file.path && recorded.sha256 === file.sha256 && recorded.size === file.size && existing === file.size) return recorded;
    throw new Error(`iCloud folder already has a different ${path.split("/").at(-1)}. Choose another folder.`);
  }
  await placeFile(target, bytes);
  return file;
}

export async function savePostToICloud(engine: Engine, id: string, options: { folder?: string; caption?: string } = {}) {
  if (["posting", "needs_reconciliation", "scheduled"].includes(getPost(engine, id).runtime.status)) throw new Error("Resolve or cancel the current publication before saving to iCloud");
  const root = icloudRoot();
  const unavailable = await icloudUnavailableReason(root);
  if (unavailable) throw new Error(unavailable);
  const current = getPost(engine, id);
  const folder = (options.folder ?? current.runtime.icloud?.folder ?? defaultPostFolderName(engine.book.get().name, current.address, id)).trim().replace(/\/+$/u, "");
  const folderError = icloudFolderError(folder);
  if (folderError) throw new Error(folderError);
  const post = await applyCaption(engine, id, options.caption);
  const outbound = await freezePostOutbound(engine, id);
  const media = await engine.files.readAtRevision(outbound.artifactId, outbound.filename, outbound.revision);
  if (!media.ok) throw new Error(media.error.message);
  const existing = post.runtime.icloud?.folder === folder ? post.runtime.icloud : undefined;
  const state: ICloudRuntime = existing ? { ...existing } : { folder };
  delete state.completedAt;
  patchPostRuntime(engine, id, { status: post.runtime.url ? post.runtime.status : "uploading", error: null, icloud: state });
  try {
    await mkdir(join(root, folder), { recursive: true });
    const files = [["video", `${folder}/clip${extname(outbound.filename)}`, media.value], ["caption", `${folder}/caption.txt`, Buffer.from(outbound.caption)]] as const;
    for (const [name, path, bytes] of files) {
      const delivered = await deliverFile(root, path, bytes, state[name]);
      state[name] = delivered;
      patchPostRuntime(engine, id, { icloud: { ...readPostRuntime(engine, id).icloud!, [name]: delivered } });
    }
    patchPostRuntime(engine, id, { status: post.runtime.url ? post.runtime.status : "ready", error: null, icloud: { ...readPostRuntime(engine, id).icloud!, completedAt: new Date().toISOString() } });
    return getPost(engine, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Saving to iCloud failed";
    patchPostRuntime(engine, id, { status: post.runtime.url ? post.runtime.status : "failed", error: message });
    throw new Error(message);
  }
}
