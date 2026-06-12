import { createB2 } from "@apicity/b2";
import type { B2Provider } from "@apicity/b2";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { getApiKey, requireApiKey } from "./api-key.js";

export type ArchiveTagSource = "manual" | "auto";

export interface ArchiveTag {
  key: string;
  label: string;
  source: ArchiveTagSource;
}

export interface ArchiveSourceRef {
  kind: "url" | "asset";
  url?: string;
  project_slug?: string;
  asset_id?: string;
  title?: string;
  created_at: string;
}

export interface ArchiveIngest {
  schema_version: 1;
  ingest_id: string;
  sha256: string;
  source: ArchiveSourceRef;
  title: string | null;
  topics: ArchiveTag[];
  people: ArchiveTag[];
  created_at: string;
}

export interface ArchiveIndex {
  schema_version: 1;
  sha256: string;
  archive_id: string;
  title: string | null;
  topics: ArchiveTag[];
  people: ArchiveTag[];
  sources: ArchiveSourceRef[];
  ingests: string[];
  media: {
    key: string;
    filename: string;
    content_type: string;
    size_bytes: number;
  };
  transcript: {
    json_key: string;
    text_key: string;
    chunk_count: number;
    provider: "elevenlabs";
  } | null;
  duration: number | null;
  created_at: string;
  updated_at: string;
}

export interface ArchiveConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  endpoint?: string;
  prefix: string;
}

export interface ObjectSummary {
  key: string;
  size?: number;
  lastModified?: string;
}

const JSON_CONTENT_TYPE = "application/json";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
const MULTIPART_PART_BYTES = 64 * 1024 * 1024;

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 404;
}

function cleanPrefix(value: string | undefined): string {
  return (value ?? "").replace(/^\/+|\/+$/g, "");
}

export function getArchiveConfig(): ArchiveConfig {
  const accessKeyId = requireApiKey("B2_ACCESS_KEY_ID");
  const secretAccessKey = requireApiKey("B2_SECRET_ACCESS_KEY");
  const region = process.env.B2_REGION;
  const bucket = process.env.B2_BUCKET;
  if (!region) throw new Error("B2_REGION environment variable is not set");
  if (!bucket) throw new Error("B2_BUCKET environment variable is not set");
  return {
    accessKeyId,
    secretAccessKey,
    region,
    bucket,
    ...(process.env.B2_ENDPOINT ? { endpoint: process.env.B2_ENDPOINT } : {}),
    prefix: cleanPrefix(process.env.B2_ARCHIVE_PREFIX),
  };
}

export function missingArchiveConfigKeys(): string[] {
  const names = ["B2_ACCESS_KEY_ID", "B2_SECRET_ACCESS_KEY", "B2_REGION", "B2_BUCKET"];
  return names.filter((name) => !process.env[name] || getApiKey(name) === null);
}

export function createArchiveB2(config = getArchiveConfig()): B2Provider {
  return createB2({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    timeout: 300_000,
  });
}

export function archiveKey(config: Pick<ArchiveConfig, "prefix">, key: string): string {
  return config.prefix ? `${config.prefix}/${key}` : key;
}

export function clipPrefix(sha256: string): string {
  return `clips/${sha256}/`;
}

export function clipKey(config: Pick<ArchiveConfig, "prefix">, sha256: string, filename: string): string {
  return archiveKey(config, `${clipPrefix(sha256)}${filename}`);
}

export function assetSnapshotPrefix(
  config: Pick<ArchiveConfig, "prefix">,
  sha256: string,
): string {
  return archiveKey(config, clipPrefix(sha256));
}

function flattenSnapshotPath(relativePath: string): string {
  return relativePath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .join("__");
}

export function assetSnapshotKey(
  config: Pick<ArchiveConfig, "prefix">,
  sha256: string,
  relativePath: string,
): string {
  return `${assetSnapshotPrefix(config, sha256)}${flattenSnapshotPath(relativePath)}`;
}

export function indexKey(config: Pick<ArchiveConfig, "prefix">, sha256: string): string {
  return clipKey(config, sha256, "archive.json");
}

export function transcriptJsonKey(config: Pick<ArchiveConfig, "prefix">, sha256: string): string {
  return clipKey(config, sha256, "transcript.json");
}

export function transcriptTextKey(config: Pick<ArchiveConfig, "prefix">, sha256: string): string {
  return clipKey(config, sha256, "transcript.txt");
}

export function chunkKey(config: Pick<ArchiveConfig, "prefix">, sha256: string, index: number): string {
  return clipKey(config, sha256, `chunk-${String(index).padStart(3, "0")}.json`);
}

export function ingestKey(config: Pick<ArchiveConfig, "prefix">, sha256: string, ingestId: string): string {
  return clipKey(config, sha256, `ingest-${ingestId}.json`);
}

export function topicMarkerKey(config: Pick<ArchiveConfig, "prefix">, topicKey: string, sha256: string, ingestId: string): string {
  return archiveKey(config, `topics/${topicKey}/${sha256}-${ingestId}.json`);
}

export function personMarkerKey(config: Pick<ArchiveConfig, "prefix">, personKey: string, sha256: string, ingestId: string): string {
  return archiveKey(config, `people/${personKey}/${sha256}-${ingestId}.json`);
}

export function normalizeArchiveKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export function archiveTags(values: string[] | undefined, source: ArchiveTagSource): ArchiveTag[] {
  const seen = new Set<string>();
  const tags: ArchiveTag[] = [];
  for (const value of values ?? []) {
    const label = value.trim().replace(/\s+/g, " ");
    const key = normalizeArchiveKey(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    tags.push({ key, label, source });
  }
  return tags;
}

export function mergeTags(groups: ArchiveTag[][]): ArchiveTag[] {
  const merged = new Map<string, ArchiveTag>();
  for (const group of groups) {
    for (const tag of group) {
      const existing = merged.get(tag.key);
      if (!existing || (existing.source === "auto" && tag.source === "manual")) {
        merged.set(tag.key, tag);
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function mergeArchiveIngests(
  ingests: ArchiveIngest[],
  args: {
    sha256: string;
    mediaKey: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    transcript: ArchiveIndex["transcript"];
    duration: number | null;
    existing?: ArchiveIndex | null;
  },
): ArchiveIndex {
  const now = new Date().toISOString();
  const sorted = [...ingests].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const existing = args.existing ?? null;
  const createdAt = existing?.created_at ?? sorted[0]?.created_at ?? now;
  const title = sorted.find((ingest) => ingest.title)?.title ?? existing?.title ?? null;
  return {
    schema_version: 1,
    sha256: args.sha256,
    archive_id: args.sha256,
    title,
    topics: mergeTags([existing?.topics ?? [], ...sorted.map((ingest) => ingest.topics)]),
    people: mergeTags([existing?.people ?? [], ...sorted.map((ingest) => ingest.people)]),
    sources: sorted.map((ingest) => ingest.source),
    ingests: sorted.map((ingest) => ingest.ingest_id),
    media: {
      key: args.mediaKey,
      filename: args.filename,
      content_type: args.contentType,
      size_bytes: args.sizeBytes,
    },
    transcript: args.transcript ?? existing?.transcript ?? null,
    duration: args.duration ?? existing?.duration ?? null,
    created_at: createdAt,
    updated_at: now,
  };
}

export function contentTypeForFilename(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".png":
      return "image/png";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function objectExists(b2: B2Provider, bucket: string, key: string): Promise<boolean> {
  try {
    await b2.objects.head({ bucket, key });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

export async function putJson(
  b2: B2Provider,
  bucket: string,
  key: string,
  value: unknown,
): Promise<void> {
  await b2.objects.put({
    bucket,
    key,
    body: JSON.stringify(value, null, 2),
    contentType: JSON_CONTENT_TYPE,
  });
}

export async function putText(
  b2: B2Provider,
  bucket: string,
  key: string,
  value: string,
): Promise<void> {
  await b2.objects.put({
    bucket,
    key,
    body: value,
    contentType: TEXT_CONTENT_TYPE,
  });
}

export async function getJson<T>(
  b2: B2Provider,
  bucket: string,
  key: string,
): Promise<T | null> {
  try {
    const response = await b2.objects.get({ bucket, key });
    const text = new TextDecoder().decode(response.body);
    return JSON.parse(text) as T;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function getText(
  b2: B2Provider,
  bucket: string,
  key: string,
): Promise<string | null> {
  try {
    const response = await b2.objects.get({ bucket, key });
    return new TextDecoder().decode(response.body);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function listObjects(
  b2: B2Provider,
  bucket: string,
  prefix: string,
): Promise<ObjectSummary[]> {
  const out: ObjectSummary[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await b2.objects.list({
      bucket,
      prefix,
      ...(continuationToken ? { continuationToken } : {}),
    });
    const contents = response.contents as Array<{ key: string; size?: number; lastModified?: string }>;
    out.push(...contents.map((item) => ({
      key: item.key,
      ...(item.size !== undefined ? { size: item.size } : {}),
      ...(item.lastModified ? { lastModified: item.lastModified } : {}),
    })));
    continuationToken = response.nextContinuationToken;
  } while (continuationToken);
  return out;
}

export async function uploadFileToB2(
  b2: B2Provider,
  bucket: string,
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  const fileStat = await stat(filePath);
  if (fileStat.size <= MULTIPART_THRESHOLD_BYTES) {
    const body = await readFile(filePath);
    await b2.objects.put({
      bucket,
      key,
      body: new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
      contentType,
    });
    return;
  }

  const create = await b2.objects.createMultipartUpload({ bucket, key, contentType });
  const parts: Array<{ partNumber: number; eTag: string }> = [];
  const handle = await open(filePath, "r");
  try {
    let offset = 0;
    let partNumber = 1;
    while (offset < fileStat.size) {
      const length = Math.min(MULTIPART_PART_BYTES, fileStat.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const read = await handle.read(buffer, 0, length, offset);
      if (read.bytesRead <= 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      const uploaded = await b2.objects.uploadPart({
        bucket,
        key,
        uploadId: create.uploadId,
        partNumber,
        body: new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)),
      });
      if (!uploaded.eTag) throw new Error(`B2 uploadPart did not return an ETag for ${key} part ${partNumber}`);
      parts.push({ partNumber, eTag: uploaded.eTag });
      offset += read.bytesRead;
      partNumber += 1;
    }
    if (offset < fileStat.size) {
      throw new Error(`Short read uploading ${key}: got ${offset} of ${fileStat.size} bytes`);
    }
    await b2.objects.completeMultipartUpload({
      bucket,
      key,
      uploadId: create.uploadId,
      parts,
    });
  } catch (error) {
    await b2.objects.abortMultipartUpload({ bucket, key, uploadId: create.uploadId }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}
