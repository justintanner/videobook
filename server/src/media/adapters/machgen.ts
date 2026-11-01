import type { CostHints } from "@apicity/cost";
import type { MachGenGenerateRequest } from "@apicity/machgen";
import { createMachGen } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { uploadAssetFile } from "../../upload.js";
import { providerEndpoints } from "../endpoints.js";
import type { Media } from "../types.js";
import { nonEmpty, record, writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type ProviderOutput, type SubmitContext, type SubmitResult } from "./types.js";

const ASSET_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export function machgenProvider(timeout = 60_000, baseURL = providerEndpoints().machgenBaseURL): ReturnType<typeof createMachGen> {
  return createMachGen({
    apiKey: requireApiKey("MACHGEN_API_KEY"),
    timeout,
    ...(baseURL ? { baseURL } : {}),
  });
}

function costHints(request: Record<string, unknown>, hints: CostHints): CostHints {
  const seconds = record(request.video_config)?.duration_secs;
  return {
    ...(typeof seconds === "number" && seconds > 0 ? { durationSeconds: seconds } : {}),
    ...hints,
  };
}

async function submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const hints = costHints(request, context.costHints);
  if (Object.keys(hints).length > 0) {
    const written = await context.engine.metadata.artifacts.write(context.assetId, "generation-cost-hints", hints);
    if (!written.ok) throw new Error(written.error.message);
  }
  const response = await machgenProvider().api.v0.generate(request as unknown as MachGenGenerateRequest, context.ctx.signal);
  const taskId = nonEmpty(response.task_id);
  if (!taskId) throw new Error("MachGen accepted the request without a task id");
  const machgenModel = typeof request.model === "string" ? request.model : context.model.apiId;
  await writePendingTask(context, taskId, MEDIA_TASK_TYPES.machgen, { machgenModel });
  return { kind: "pending", taskId };
}

function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) return "jpg";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  return "png";
}

export async function downloadMachGenOutput(taskId: string, media: Media, url?: string): Promise<ProviderOutput> {
  const bytes = Buffer.from(await machgenProvider(ASSET_DOWNLOAD_TIMEOUT_MS).api.v0.assets(taskId));
  if (bytes.length === 0) throw new Error(`MachGen task ${taskId} returned an empty ${media}`);
  return { bytes, extension: media === "image" ? imageExtension(bytes) : "mp4", ...(url ? { url } : {}) };
}

export const machgenAdapter: ProviderAdapter = {
  provider: "machgen",
  envKey: "MACHGEN_API_KEY",
  upload: uploadAssetFile,
  uploadUrl: async (url) => url,
  submit,
};
