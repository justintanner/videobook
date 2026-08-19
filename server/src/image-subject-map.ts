import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ArtifactManifestFile, Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { z } from "zod";

export const IMAGE_SUBJECT_MAP_VERSION = 1 as const;
export const IMAGE_SUBJECT_MAP_METADATA_KEY = "image-subject-map.v1";

const imageSubjectMapWriteChains = new Map<string, Promise<void>>();

const normalizedBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().refine(
  (box) => box.x + box.width <= 1.001 && box.y + box.height <= 1.001,
  { message: "subject box extends beyond the image" },
);

const subjectSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  normalizedBox: normalizedBoxSchema,
  layerFile: z.string().min(1),
  thumbnailFile: z.string().min(1),
  zIndex: z.number().int(),
  exactEdit: z.boolean(),
}).strict();

const subjectsSchema = z.array(subjectSchema).superRefine((subjects, context) => {
  const ids = new Set<string>();
  const zIndexes = new Set<number>();
  for (const [index, subject] of subjects.entries()) {
    if (ids.has(subject.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `duplicate subject id ${subject.id}`,
      });
    }
    if (zIndexes.has(subject.zIndex)) {
      context.addIssue({
        code: "custom",
        path: [index, "zIndex"],
        message: `duplicate subject z-index ${subject.zIndex}`,
      });
    }
    ids.add(subject.id);
    zIndexes.add(subject.zIndex);
  }
});

const recordBaseSchema = z.object({
  version: z.literal(IMAGE_SUBJECT_MAP_VERSION),
  artifactId: z.string().min(1),
  objectHash: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  jobId: z.string().min(1),
}).strict();

const analyzingRecordSchema = recordBaseSchema.extend({
  status: z.literal("analyzing"),
  startedAt: z.string().min(1),
  taskId: z.string().min(1).optional(),
});

const failedRecordSchema = recordBaseSchema.extend({
  status: z.literal("failed"),
  error: z.string().min(1),
  failedAt: z.string().min(1),
  taskId: z.string().min(1).optional(),
});

const readyRecordSchema = recordBaseSchema.extend({
  status: z.literal("ready"),
  provider: z.literal("kie"),
  model: z.literal("seedream/5-pro-layer-decomposition"),
  analysisId: z.string().min(1),
  analyzedAt: z.string().min(1),
  taskId: z.string().min(1),
  baseFile: z.string().min(1),
  subjects: subjectsSchema,
});

export const imageSubjectMapRecordSchema = z.discriminatedUnion("status", [
  analyzingRecordSchema,
  failedRecordSchema,
  readyRecordSchema,
]);

export type ImageSubjectNormalizedBox = z.infer<typeof normalizedBoxSchema>;
export type ImageSubject = z.infer<typeof subjectSchema>;
export type ImageSubjectMapRecordV1 = z.infer<typeof imageSubjectMapRecordSchema>;
export type ImageSubjectMapReadyV1 = z.infer<typeof readyRecordSchema>;

export type ImageSubjectSource = {
  artifactId: string;
  file: ArtifactManifestFile;
  objectHash: string;
  width: number;
  height: number;
};

export type SeedreamLayerInput = {
  url: string;
  name?: string;
  description?: string;
  zIndex: number;
  normalizedBox?: ImageSubjectNormalizedBox;
};

const SUBJECT_COLORS = [
  "#ef4444",
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#6366f1",
  "#14b8a6",
  "#eab308",
] as const;

function imageFileUrl(
  bookId: string,
  artifactId: string,
  filename: string,
): string {
  const encodedFilename = filename
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/files/${encodeURIComponent(bookId)}/${encodeURIComponent(artifactId)}/${encodedFilename}`;
}

function positiveDimension(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export async function resolveImageSubjectSource(
  engine: Engine,
  artifactId: string,
): Promise<ImageSubjectSource> {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  if (artifact.value.kind !== "image") {
    throw new Error(`Image subject analysis requires an image artifact, got ${artifact.value.kind}`);
  }
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
  if (!file) throw new Error(`No primary image file found for ${artifactId}`);

  const metadata = await engine.metadata.artifacts.read<Record<string, unknown>>(
    artifactId,
    "original",
  );
  let width = metadata.ok ? positiveDimension(metadata.value?.width) : null;
  let height = metadata.ok ? positiveDimension(metadata.value?.height) : null;
  if (!width || !height) {
    const read = await engine.files.read(artifactId, file.name);
    if (!read.ok) throw new Error(read.error.message);
    const probed = await sharp(read.value).metadata();
    width = positiveDimension(probed.width);
    height = positiveDimension(probed.height);
  }
  if (!width || !height) {
    throw new Error(`Could not determine dimensions for ${artifactId}`);
  }
  return {
    artifactId,
    file,
    objectHash: file.objectHash,
    width,
    height,
  };
}

export async function readImageSubjectMapRecord(
  engine: Engine,
  artifactId: string,
): Promise<ImageSubjectMapRecordV1 | null> {
  const result = await engine.metadata.artifacts.read<unknown>(
    artifactId,
    IMAGE_SUBJECT_MAP_METADATA_KEY,
  );
  if (!result.ok) return null;
  const parsed = imageSubjectMapRecordSchema.safeParse(result.value);
  return parsed.success ? parsed.data : null;
}

async function serializeImageSubjectMapWrite<T>(
  artifactId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = imageSubjectMapWriteChains.get(artifactId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  imageSubjectMapWriteChains.set(artifactId, tail);
  return await result.finally(() => {
    if (imageSubjectMapWriteChains.get(artifactId) === tail) {
      imageSubjectMapWriteChains.delete(artifactId);
    }
  });
}

async function writeImageSubjectMapRecordUnlocked(
  engine: Engine,
  record: ImageSubjectMapRecordV1,
): Promise<void> {
  const parsed = imageSubjectMapRecordSchema.parse(record);
  const result = await engine.metadata.artifacts.write(
    record.artifactId,
    IMAGE_SUBJECT_MAP_METADATA_KEY,
    parsed,
  );
  if (!result.ok) throw new Error(result.error.message);
}

export async function writeImageSubjectMapRecord(
  engine: Engine,
  record: ImageSubjectMapRecordV1,
): Promise<void> {
  await serializeImageSubjectMapWrite(record.artifactId, async () => {
    await writeImageSubjectMapRecordUnlocked(engine, record);
  });
}

export async function writeCurrentImageSubjectAnalysisRecord(
  engine: Engine,
  record: ImageSubjectMapRecordV1,
): Promise<boolean> {
  return await serializeImageSubjectMapWrite(record.artifactId, async () => {
    const current = await readImageSubjectMapRecord(engine, record.artifactId);
    if (
      current?.status !== "analyzing"
      || current.objectHash !== record.objectHash
      || current.jobId !== record.jobId
    ) {
      return false;
    }
    await writeImageSubjectMapRecordUnlocked(engine, record);
    return true;
  });
}

export function subjectAnalysisProviderFailureMessage(
  message: string | null | undefined,
  code?: string | null,
): string {
  const detail = message?.trim() || code?.trim() || "Unknown provider error";
  const codeDetail = code?.trim() && code.trim() !== detail
    ? ` (${code.trim()})`
    : "";
  const normalized = `${detail}${codeDetail}`.replace(/[.\s]+$/u, "");
  if (
    normalized.startsWith("Subject analysis provider failed:")
    && normalized.includes("Retry in a moment")
  ) {
    return `${normalized}.`;
  }
  return `Subject analysis provider failed: ${normalized}. Retry in a moment.`;
}

export function imageSubjectMapResponse(
  bookId: string,
  source: ImageSubjectSource,
  record: ImageSubjectMapRecordV1 | null,
): Record<string, unknown> {
  if (!record || record.objectHash !== source.objectHash) {
    return {
      status: "idle",
      artifact_id: source.artifactId,
      object_hash: source.objectHash,
      width: source.width,
      height: source.height,
      base_url: null,
      error: null,
      job_id: null,
      subjects: [],
    };
  }
  if (record.status !== "ready") {
    return {
      status: record.status,
      artifact_id: source.artifactId,
      object_hash: source.objectHash,
      width: source.width,
      height: source.height,
      base_url: null,
      error: record.status === "failed" ? record.error : null,
      job_id: record.jobId,
      ...(record.status === "analyzing"
        ? { started_at: record.startedAt }
        : {}),
      subjects: [],
    };
  }
  return {
    status: "ready",
    artifact_id: source.artifactId,
    object_hash: source.objectHash,
    width: record.width,
    height: record.height,
    base_url: imageFileUrl(bookId, source.artifactId, record.baseFile),
    error: null,
    job_id: record.jobId,
    subjects: record.subjects.map((subject) => ({
      id: subject.id,
      label: subject.label,
      description: subject.description,
      color: subject.color,
      normalized_box: subject.normalizedBox,
      layer_url: imageFileUrl(bookId, source.artifactId, subject.layerFile),
      thumbnail_url: imageFileUrl(bookId, source.artifactId, subject.thumbnailFile),
      z_index: subject.zIndex,
      capabilities: {
        remove: true,
        exact_edit: subject.exactEdit,
      },
    })),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pixelBox(
  box: ImageSubjectNormalizedBox,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const left = clamp(Math.round(box.x * width), 0, width - 1);
  const top = clamp(Math.round(box.y * height), 0, height - 1);
  const boxWidth = clamp(Math.round(box.width * width), 1, width - left);
  const boxHeight = clamp(Math.round(box.height * height), 1, height - top);
  return { left, top, width: boxWidth, height: boxHeight };
}

async function fullCanvasLayer(
  input: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  box: ImageSubjectNormalizedBox | undefined,
): Promise<Buffer> {
  const metadata = await sharp(input).metadata();
  if (metadata.width === sourceWidth && metadata.height === sourceHeight) {
    return sharp(input).ensureAlpha().png().toBuffer();
  }
  if (box) {
    const placement = pixelBox(box, sourceWidth, sourceHeight);
    const resized = await sharp(input)
      .ensureAlpha()
      .resize(placement.width, placement.height, { fit: "fill" })
      .png()
      .toBuffer();
    return sharp({
      create: {
        width: sourceWidth,
        height: sourceHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).composite([{ input: resized, left: placement.left, top: placement.top }])
      .png()
      .toBuffer();
  }
  throw new Error(
    `Seedream layer dimensions ${metadata.width ?? 0}x${metadata.height ?? 0} do not match ${sourceWidth}x${sourceHeight} and have no valid bounding box`,
  );
}

export async function alphaBoundingBox(
  input: Buffer,
): Promise<ImageSubjectNormalizedBox> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      if (alpha === undefined || alpha <= 4) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) {
    throw new Error("Seedream returned an all-transparent subject layer");
  }
  return {
    x: minX / info.width,
    y: minY / info.height,
    width: (maxX - minX + 1) / info.width,
    height: (maxY - minY + 1) / info.height,
  };
}

function subjectId(layer: Buffer, zIndex: number): string {
  const hash = createHash("sha256")
    .update(layer)
    .update(":")
    .update(String(zIndex))
    .digest("hex")
    .slice(0, 16);
  return `subject-${hash}`;
}

async function subjectThumbnail(
  layer: Buffer,
  box: ImageSubjectNormalizedBox,
  width: number,
  height: number,
): Promise<Buffer> {
  const region = pixelBox(box, width, height);
  return sharp(layer)
    .extract(region)
    .resize(192, 192, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

export async function persistSeedreamSubjectLayers(
  engine: Engine,
  source: ImageSubjectSource,
  input: {
    jobId: string;
    taskId: string;
    baseUrl: string;
    layers: SeedreamLayerInput[];
    signal?: AbortSignal;
  },
): Promise<ImageSubjectMapReadyV1> {
  const analysisId = input.taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const root = `.image-subjects/${source.objectHash}/${analysisId}`;
  const baseResponse = await fetch(input.baseUrl, { signal: input.signal });
  if (!baseResponse.ok) {
    throw new Error(`Failed to download Seedream base: ${baseResponse.status} ${baseResponse.statusText}`);
  }
  const base = await sharp(Buffer.from(await baseResponse.arrayBuffer()))
    .resize(source.width, source.height, { fit: "fill" })
    .png()
    .toBuffer();
  const baseFile = `${root}/base.png`;
  const baseWrite = await engine.files.write(source.artifactId, baseFile, base);
  if (!baseWrite.ok) throw new Error(baseWrite.error.message);

  const ordered = [...input.layers].sort((left, right) => left.zIndex - right.zIndex);
  const subjects: ImageSubject[] = [];
  for (const [index, layer] of ordered.entries()) {
    const response = await fetch(layer.url, { signal: input.signal });
    if (!response.ok) {
      throw new Error(`Failed to download Seedream layer: ${response.status} ${response.statusText}`);
    }
    const canvas = await fullCanvasLayer(
      Buffer.from(await response.arrayBuffer()),
      source.width,
      source.height,
      layer.normalizedBox,
    );
    const normalizedBox = await alphaBoundingBox(canvas);
    const id = subjectId(canvas, layer.zIndex);
    const layerFile = `${root}/layer-${index}-${id}.png`;
    const thumbnailFile = `${root}/thumbnail-${index}-${id}.png`;
    const thumbnail = await subjectThumbnail(
      canvas,
      normalizedBox,
      source.width,
      source.height,
    );
    const [layerWrite, thumbnailWrite] = await Promise.all([
      engine.files.write(source.artifactId, layerFile, canvas),
      engine.files.write(source.artifactId, thumbnailFile, thumbnail),
    ]);
    if (!layerWrite.ok) throw new Error(layerWrite.error.message);
    if (!thumbnailWrite.ok) throw new Error(thumbnailWrite.error.message);
    subjects.push({
      id,
      label: layer.name?.trim() || `Subject ${index + 1}`,
      description: layer.description?.trim() || "",
      color: SUBJECT_COLORS[index % SUBJECT_COLORS.length]!,
      normalizedBox,
      layerFile,
      thumbnailFile,
      zIndex: layer.zIndex,
      exactEdit: false,
    });
  }
  return readyRecordSchema.parse({
    version: IMAGE_SUBJECT_MAP_VERSION,
    status: "ready",
    artifactId: source.artifactId,
    objectHash: source.objectHash,
    width: source.width,
    height: source.height,
    jobId: input.jobId,
    provider: "kie",
    model: "seedream/5-pro-layer-decomposition",
    analysisId,
    analyzedAt: new Date().toISOString(),
    taskId: input.taskId,
    baseFile,
    subjects,
  });
}

export async function composeImageSubjectRemoval(
  engine: Engine,
  sourceArtifactId: string,
  record: ImageSubjectMapReadyV1,
  removedSubjectIds: readonly string[],
): Promise<Buffer> {
  const selected = new Set(removedSubjectIds);
  const known = new Set(record.subjects.map((subject) => subject.id));
  const missing = [...selected].filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown subject ids: ${missing.join(", ")}`);
  }
  const baseRead = await engine.files.read(sourceArtifactId, record.baseFile);
  if (!baseRead.ok) throw new Error(baseRead.error.message);
  const retained = record.subjects
    .filter((subject) => !selected.has(subject.id))
    .sort((left, right) => left.zIndex - right.zIndex);
  const layers: Buffer[] = [];
  for (const subject of retained) {
    const read = await engine.files.read(sourceArtifactId, subject.layerFile);
    if (!read.ok) throw new Error(read.error.message);
    layers.push(Buffer.from(read.value));
  }
  return sharp(baseRead.value)
    .resize(record.width, record.height, { fit: "fill" })
    .composite(layers.map((layer) => ({ input: layer, left: 0, top: 0 })))
    .png()
    .toBuffer();
}
