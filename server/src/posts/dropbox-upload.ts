import { createHash } from "node:crypto";
import { extname } from "node:path";
import { DropboxError } from "@apicity/dropbox";
import type { DropboxProvider } from "@apicity/dropbox";
import type { Engine } from "videobook-engine";
import { dropboxClient } from "./dropbox-auth.js";
import { freezePostOutbound, getPost, patchPostRuntime, readPostRuntime, updatePost } from "./post-store.js";
import type { PostUploadFile } from "./post-contract.js";

const CHUNK = 8 * 1024 * 1024;

export function dropboxContentHash(bytes: Buffer): string {
  const hashes: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) hashes.push(createHash("sha256").update(bytes.subarray(offset, offset + 4 * 1024 * 1024)).digest());
  return createHash("sha256").update(Buffer.concat(hashes)).digest("hex");
}

function correctOffset(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (typeof object.correct_offset === "number") return object.correct_offset;
  for (const child of Object.values(object)) {
    const result = correctOffset(child);
    if (result !== null) return result;
  }
  return null;
}

async function uploadFile(client: DropboxProvider, bytes: Buffer, initial: PostUploadFile, persist: (value: PostUploadFile) => void, signal?: AbortSignal): Promise<void> {
  let state = { ...initial };
  const save = (patch: Partial<PostUploadFile>) => { state = { ...state, ...patch }; persist(state); };
  try {
    const metadata = await client.files.getMetadata({ path: state.path }, signal);
    if (metadata[".tag"] === "file" && metadata.content_hash === state.hash) {
      save({ id: String(metadata.id), rev: String(metadata.rev), offset: bytes.length });
      return;
    }
    throw new Error("The Dropbox destination already contains different content. Choose a new destination folder.");
  } catch (error) {
    if (!(error instanceof DropboxError) || !error.error_summary?.startsWith("path/not_found")) throw error;
  }
  if (state.rev) throw new Error("A previously uploaded Dropbox file was removed. Choose a new destination folder.");
  for (let recovery = 0; recovery < 4; recovery += 1) {
    try {
      if (!state.sessionId) {
        const session = await client.files.uploadSession.start({ contents: new Uint8Array() }, signal);
        save({ sessionId: session.session_id, offset: 0 });
      }
      while (state.offset < bytes.length) {
        const end = Math.min(state.offset + CHUNK, bytes.length);
        await client.files.uploadSession.appendV2({ contents: new Uint8Array(bytes.subarray(state.offset, end)), cursor: { session_id: state.sessionId!, offset: state.offset } }, signal);
        save({ offset: end });
      }
      const finished = await client.files.uploadSession.finish({ contents: new Uint8Array(), cursor: { session_id: state.sessionId!, offset: state.offset }, commit: { path: state.path, mode: "add", autorename: false, mute: true, strict_conflict: true } }, signal);
      if (finished.content_hash && finished.content_hash !== state.hash) throw new Error("Dropbox returned different file content. Choose a new destination folder.");
      save({ id: finished.id, rev: finished.rev, offset: bytes.length });
      return;
    } catch (error) {
      if (!(error instanceof DropboxError)) throw error;
      const offset = correctOffset(error.error);
      if (offset !== null && offset >= 0 && offset <= bytes.length) { save({ offset }); continue; }
      if (error.error_summary?.includes("not_found") || error.error_summary?.includes("closed") || error.error_summary?.includes("conflict")) {
        try {
          const metadata = await client.files.getMetadata({ path: state.path }, signal);
          if (metadata[".tag"] === "file" && metadata.content_hash === state.hash) { save({ id: String(metadata.id), rev: String(metadata.rev), offset: bytes.length }); return; }
          throw new Error("Dropbox destination content changed");
        } catch (lookup) {
          if (!(lookup instanceof DropboxError) || !lookup.error_summary?.startsWith("path/not_found")) throw lookup;
        }
        save({ sessionId: undefined, offset: 0 });
        continue;
      }
      throw error;
    }
  }
  throw new Error("Dropbox upload could not reconcile its saved position. Retry the upload.");
}

async function applyCaption(engine: Engine, id: string, caption: string | undefined) {
  const post = getPost(engine, id);
  if (caption === undefined || caption === post.definition.caption) return post;
  if (post.runtime.outbound) throw new Error("This Post's caption was frozen at its first delivery. Create a new Post to deliver a different caption.");
  return updatePost(engine, id, { caption });
}

export async function uploadPostToDropbox(engine: Engine, id: string, options: { folder?: string; caption?: string; client?: DropboxProvider; signal?: AbortSignal } = {}) {
  if (["posting", "needs_reconciliation", "scheduled"].includes(getPost(engine, id).runtime.status)) throw new Error("Resolve or cancel the current publication before uploading");
  const post = await applyCaption(engine, id, options.caption);
  const outbound = await freezePostOutbound(engine, id);
  const folder = options.folder?.replace(/\/+$/, "") ?? post.runtime.dropbox?.folder ?? `/Videobook/${engine.book.get().name}/${id}`;
  if (!folder.startsWith("/") || folder.includes("..") || [...folder].some(character => character.charCodeAt(0) < 32)) throw new Error("Use an absolute Dropbox folder without .. segments");
  const media = await engine.files.readAtRevision(outbound.artifactId, outbound.filename, outbound.revision);
  if (!media.ok) throw new Error(media.error.message);
  const caption = Buffer.from(outbound.caption);
  const existing = post.runtime.dropbox?.folder === folder ? post.runtime.dropbox : undefined;
  patchPostRuntime(engine, id, { status: "uploading", error: null, dropbox: existing ?? {
    folder,
    video: { path: `${folder}/clip${extname(outbound.filename)}`, hash: dropboxContentHash(media.value), offset: 0 },
    caption: { path: `${folder}/caption.txt`, hash: dropboxContentHash(caption), offset: 0 },
  } });
  try {
    const client = options.client ?? await dropboxClient();
    for (const [name, bytes] of [["video", media.value], ["caption", caption]] as const) {
      const state = readPostRuntime(engine, id).dropbox!;
      await uploadFile(client, bytes, state[name], (file) => {
        const current = readPostRuntime(engine, id).dropbox!;
        patchPostRuntime(engine, id, { dropbox: { ...current, [name]: file } });
      }, options.signal);
    }
    patchPostRuntime(engine, id, { status: post.runtime.url ? post.runtime.status : "ready", error: null, dropbox: { ...readPostRuntime(engine, id).dropbox!, completedAt: new Date().toISOString() } });
    return getPost(engine, id);
  } catch (error) {
    const message = error instanceof DropboxError ? `Dropbox upload failed (${error.status}). ${error.status === 401 ? "Reconnect Dropbox and retry." : "Retry to resume the saved upload."}` : error instanceof Error ? error.message : "Dropbox upload failed";
    patchPostRuntime(engine, id, { status: post.runtime.url ? post.runtime.status : "failed", error: message });
    throw new Error(message);
  }
}
