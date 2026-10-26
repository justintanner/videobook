import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { z } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { isActiveJob, latestComponentJob } from "../analysis-components.js";
import { cachedSidecarAnalysis, readArtifactJson, sidecarJobKey, sidecarOutputs } from "../analysis-sidecars.js";
import type { SidecarInput } from "../analysis-sidecars.js";
import type { DescribeImageResult } from "../jobs/describe-image.js";
import { SCRIPT_FILENAME, writeDescriptionScript } from "../jobs/describe-image.js";
import { IMAGE_DESCRIPTION, imageDescriptionRecord } from "../vision-components.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

const describeChains = new Map<string, Promise<unknown>>();

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (describeChains.get(key) ?? Promise.resolve()).then(run);
  describeChains.set(key, next.catch(() => undefined));
  return next;
}

async function reusableScript(engine: Engine, record: SidecarInput): Promise<string | null> {
  for (const scriptId of sidecarOutputs(engine, IMAGE_DESCRIPTION, record.key).reverse()) {
    if (engine.artifacts.get(scriptId).ok && (await engine.files.read(scriptId, SCRIPT_FILENAME)).ok) return scriptId;
  }
  return null;
}

async function scriptFromCache(engine: Engine, sourceAssetId: string, scriptName: string, record: SidecarInput): Promise<string> {
  const existing = await reusableScript(engine, record);
  if (existing) return existing;
  const created = await engine.artifacts.create("script", scriptName);
  if (!created.ok) throw new Error(`Failed to create script asset: ${created.error.message}`);
  const result = await readArtifactJson(engine, sourceAssetId, IMAGE_DESCRIPTION.sidecar) as DescribeImageResult;
  await writeDescriptionScript(engine, created.value.artifactId, sourceAssetId, { result, key: record.key });
  return created.value.artifactId;
}

async function requestDescription(
  engine: Engine,
  input: { sourceAssetId: string; bookId: string; imageFile: ArtifactManifestFile; scriptName: string; force: boolean },
): Promise<ToolResult> {
  const record = imageDescriptionRecord(engine, input.sourceAssetId, input.imageFile.objectHash);
  const base = { source_asset_id: input.sourceAssetId };
  if (!input.force && await cachedSidecarAnalysis(engine, IMAGE_DESCRIPTION, record)) {
    const scriptAssetId = await scriptFromCache(engine, input.sourceAssetId, input.scriptName, record);
    return ok({ ...base, script_asset_id: scriptAssetId, job_id: null, status: "cached" });
  }
  const active = latestComponentJob(engine, IMAGE_DESCRIPTION, record.key);
  if (active && isActiveJob(active) && typeof active.payload.assetId === "string") {
    return ok({ ...base, script_asset_id: active.payload.assetId, job_id: active.id, status: active.state === "queued" ? "queued" : "running" });
  }
  if (!process.env.OPENAI_API_KEY) return error("OPENAI_API_KEY is not set");

  const createResult = await engine.artifacts.create("script", input.scriptName);
  if (!createResult.ok) return error(`Failed to create script asset: ${createResult.error.message}`);
  const scriptAssetId = createResult.value.artifactId;
  const job = await queue.enqueue(sidecarJobKey(IMAGE_DESCRIPTION, record.key), {
    type: "describe_image",
    sourceAssetId: input.sourceAssetId,
    sourceImageFilename: input.imageFile.name,
    assetId: scriptAssetId,
    bookId: input.bookId,
    componentKey: record.key,
    force: input.force,
  });
  return ok({ ...base, script_asset_id: scriptAssetId, job_id: job.id, status: "queued" });
}

export function describeImageDef(engine: Engine): ToolDef {
  return {
    name: "describe_image",
    description:
      "Write a reproduction-ready prompt for an image asset into a script asset using vision (asynchronous). Returns status cached with the existing script when the current image was already described; a repeated or concurrent request joins the running job.",
    schema: {
      asset_id: z.string().describe("Image artifact id"),
      book_id: z.string().describe("Book UUID"),
      force: z.boolean().optional().default(false).describe("Describe again even when the current image was already described"),
    },
    handler: async (args) => {
      const { asset_id, book_id, force } = args as {
        asset_id: string;
        book_id: string;
        force: boolean;
      };

      const sourceArtifact = engine.artifacts.get(asset_id);
      if (!sourceArtifact.ok) return error(sourceArtifact.error.message);
      if (sourceArtifact.value.kind !== "image") {
        return error(`describe_image only accepts image artifacts, got ${sourceArtifact.value.kind} artifact ${asset_id}`);
      }

      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return error(manifestResult.error.message);
      }

      const imageFile = findImageFile(manifestResult.value.files);
      if (!imageFile) {
        return error(`No image file found in artifact ${asset_id}`);
      }

      const scriptName = `desc ${sourceArtifact.value.label ?? asset_id}`;
      return serialized(asset_id, () => requestDescription(engine, { sourceAssetId: asset_id, bookId: book_id, imageFile, scriptName, force }));
    },
  };
}
