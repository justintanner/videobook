import type { B2Provider } from "@apicity/b2";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve, sep } from "node:path";
import { getProjectsDir } from "./queue.js";
import {
  archiveKey,
  clipPrefix,
  createArchiveB2,
  getArchiveConfig,
  getJson,
  getText,
  listObjects,
  missingArchiveConfigKeys,
  objectExists,
  putJson,
  putText,
  uploadFileToB2,
} from "./archive-b2.js";
import type { ArchiveConfig, ArchiveIngest, ObjectSummary } from "./archive-b2.js";

export interface PresignedMedia {
  url: string;
  expiresAt: string | null;
}

export interface ArchiveStore {
  kind: "b2" | "local";
  prefix: string;
  exists(key: string): Promise<boolean>;
  putJson(key: string, value: unknown): Promise<void>;
  putText(key: string, value: string): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  getText(key: string): Promise<string | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<ObjectSummary[]>;
  uploadFile(key: string, filePath: string, contentType: string): Promise<void>;
  presignGet(key: string, expiresInSeconds: number): PresignedMedia | null;
}

export function localArchiveDir(): string {
  const fromEnv = process.env.VIDEOBOOK_ARCHIVE_DIR;
  if (fromEnv) return resolve(fromEnv);
  return join(dirname(resolve(getProjectsDir())), "archive");
}

export function isArchiveB2Configured(): boolean {
  return missingArchiveConfigKeys().length === 0;
}

export function getArchiveStore(): ArchiveStore {
  if (isArchiveB2Configured()) return createB2ArchiveStore();
  return createLocalArchiveStore(localArchiveDir());
}

export function createB2ArchiveStore(config: ArchiveConfig = getArchiveConfig()): ArchiveStore {
  const b2: B2Provider = createArchiveB2(config);
  return {
    kind: "b2",
    prefix: config.prefix,
    exists: (key) => objectExists(b2, config.bucket, key),
    putJson: (key, value) => putJson(b2, config.bucket, key, value),
    putText: (key, value) => putText(b2, config.bucket, key, value),
    getJson: (key) => getJson(b2, config.bucket, key),
    getText: (key) => getText(b2, config.bucket, key),
    getBytes: async (key) => {
      try {
        const response = await b2.objects.get({ bucket: config.bucket, key });
        return new Uint8Array(response.body);
      } catch (error) {
        if ((error as { status?: unknown } | null)?.status === 404) return null;
        throw error;
      }
    },
    list: (prefix) => listObjects(b2, config.bucket, prefix),
    uploadFile: (key, filePath, contentType) => uploadFileToB2(b2, config.bucket, key, filePath, contentType),
    presignGet: (key, expiresInSeconds) => {
      const signed = b2.presign.getObject({ bucket: config.bucket, key, expiresIn: expiresInSeconds });
      return signed?.url ? { url: signed.url, expiresAt: signed.expiresAt ?? null } : null;
    },
  };
}

function localPathForKey(rootDir: string, key: string): string {
  const segments = key.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid archive key: ${key}`);
  }
  const fullPath = join(rootDir, ...segments);
  if (fullPath !== rootDir && !fullPath.startsWith(rootDir + sep)) {
    throw new Error(`Invalid archive key: ${key}`);
  }
  return fullPath;
}

function isFsNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

async function readLocalFile(rootDir: string, key: string): Promise<Buffer | null> {
  try {
    return await readFile(localPathForKey(rootDir, key));
  } catch (error) {
    if (isFsNotFound(error)) return null;
    throw error;
  }
}

async function writeLocalFile(rootDir: string, key: string, body: string | Uint8Array): Promise<void> {
  const fullPath = localPathForKey(rootDir, key);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, body);
}

async function walkLocalKeys(rootDir: string, dir: string, out: ObjectSummary[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isFsNotFound(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkLocalKeys(rootDir, fullPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(fullPath);
    out.push({
      key: fullPath.slice(rootDir.length + 1).split(sep).join("/"),
      size: fileStat.size,
      lastModified: fileStat.mtime.toISOString(),
    });
  }
}

export function localArchiveMediaUrl(key: string): string {
  return `/archive-files/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function createLocalArchiveStore(rootDir: string): ArchiveStore {
  const root = resolve(rootDir);
  return {
    kind: "local",
    prefix: "",
    exists: async (key) => {
      try {
        const fileStat = await stat(localPathForKey(root, key));
        return fileStat.isFile();
      } catch (error) {
        if (isFsNotFound(error)) return false;
        throw error;
      }
    },
    putJson: (key, value) => writeLocalFile(root, key, JSON.stringify(value, null, 2)),
    putText: (key, value) => writeLocalFile(root, key, value),
    getJson: async <T>(key: string) => {
      const body = await readLocalFile(root, key);
      return body === null ? null : JSON.parse(body.toString("utf8")) as T;
    },
    getText: async (key) => {
      const body = await readLocalFile(root, key);
      return body === null ? null : body.toString("utf8");
    },
    getBytes: async (key) => {
      const body = await readLocalFile(root, key);
      return body === null ? null : new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    },
    list: async (prefix) => {
      const out: ObjectSummary[] = [];
      await walkLocalKeys(root, root, out);
      return out
        .filter((item) => item.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    uploadFile: async (key, filePath) => {
      const fullPath = localPathForKey(root, key);
      await mkdir(dirname(fullPath), { recursive: true });
      await pipeline(createReadStream(filePath), createWriteStream(fullPath));
    },
    presignGet: (key) => ({ url: localArchiveMediaUrl(key), expiresAt: null }),
  };
}

export async function readArchiveIngests(store: ArchiveStore, sha256: string): Promise<ArchiveIngest[]> {
  const keys = (await store.list(archiveKey(store, clipPrefix(sha256))))
    .map((item) => item.key)
    .filter((key) => /\/ingest-[^/]+\.json$/.test(key));
  const ingests = await Promise.all(keys.map((key) => store.getJson<ArchiveIngest>(key)));
  return ingests.filter((ingest): ingest is ArchiveIngest => ingest !== null);
}
