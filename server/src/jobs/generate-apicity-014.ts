import type { MediaGenerationRequest } from "@apicity/kie";
import type { Engine } from "videobook-engine";
import type { JobHandlerContext } from "../queue.js";
import { registerJobHandler } from "../queue.js";
import { withProviderHandoff } from "./_lease.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { submitFalJob } from "./_fal-shared.js";
import { submitKieTask } from "./kie-paygate.js";
import { resolveImageRefs } from "../tools/_image-inputs.js";
import { resolveVideoRef } from "../tools/_seedance2-shared.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";
import {
  apicity014Action,
  apicity014Actions,
  buildApicity014Payload,
  type Apicity014Action,
} from "../apicity-014-media.js";

type Apicity014JobPayload = {
  type: string;
  toolName: string;
  bookId: string;
  assetId: string;
  assetDir: string;
  args: Record<string, unknown>;
};

type ResolvedMedia = {
  args: Record<string, unknown>;
  sourceImageIds: string[];
  sourceVideoIds: string[];
};

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

async function uploadMedia(
  engine: Engine,
  provider: Apicity014Action["provider"],
  assetId: string,
  filename: string,
): Promise<string> {
  return provider === "fal"
    ? uploadAssetToFal(engine, assetId, filename)
    : uploadAssetToKie(engine, assetId, filename);
}

async function resolveImageUrl(
  engine: Engine,
  provider: Apicity014Action["provider"],
  ref: string,
  sourceImageIds: string[],
): Promise<string> {
  if (isHttpUrl(ref)) return ref;
  const resolved = await resolveImageRefs(engine, [ref]);
  if (!resolved.ok) throw new Error(resolved.error);
  const input = resolved.inputs[0];
  if (!input) throw new Error(`No image resolved for ${ref}`);
  sourceImageIds.push(...resolved.sourceImageIds);
  if ("url" in input) return input.url;
  return uploadMedia(engine, provider, input.assetId, input.filename);
}

async function resolveVideoUrl(
  engine: Engine,
  provider: Apicity014Action["provider"],
  ref: string,
  sourceVideoIds: string[],
): Promise<string> {
  if (isHttpUrl(ref)) return ref;
  const resolved = await resolveVideoRef(engine, ref);
  if (!resolved.ok) throw new Error(resolved.error);
  sourceVideoIds.push(resolved.value.assetId);
  return uploadMedia(engine, provider, resolved.value.assetId, resolved.value.filename);
}

async function resolveJobMedia(
  engine: Engine,
  action: Apicity014Action,
  args: Record<string, unknown>,
): Promise<ResolvedMedia> {
  const sourceImageIds: string[] = [];
  const sourceVideoIds: string[] = [];
  const resolved: Record<string, unknown> = { ...args };
  if ("image_refs" in args) {
    const urls: string[] = [];
    for (const ref of stringList(args.image_refs)) {
      urls.push(await resolveImageUrl(engine, action.provider, ref, sourceImageIds));
    }
    resolved.image_refs = urls;
  }
  if (typeof args.video_ref === "string" && args.video_ref.trim() !== "") {
    resolved.video_ref = await resolveVideoUrl(engine, action.provider, args.video_ref, sourceVideoIds);
  }
  if ("video_refs" in args) {
    const urls: string[] = [];
    for (const ref of stringList(args.video_refs)) {
      urls.push(await resolveVideoUrl(engine, action.provider, ref, sourceVideoIds));
    }
    resolved.video_refs = urls;
  }
  return { args: resolved, sourceImageIds, sourceVideoIds };
}

function parsedPayload(action: Apicity014Action, args: Record<string, unknown>): Record<string, unknown> {
  const payload = buildApicity014Payload(action.canonicalName, args);
  if (!payload) throw new Error(`No payload for ${action.canonicalName}`);
  const parsed = action.requestSchema.safeParse(payload);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid ${action.canonicalName} payload: ${message}`);
  }
  return parsed.data as Record<string, unknown>;
}

function generationMeta(
  args: Record<string, unknown>,
  action: Apicity014Action,
  media: ResolvedMedia,
): Record<string, unknown> {
  return {
    prompt: typeof args.prompt === "string" ? args.prompt : "",
    sourceImageIds: media.sourceImageIds,
    sourceVideoIds: media.sourceVideoIds,
    model: action.provenanceModel,
    apiModel: action.provenanceModel,
  };
}

async function submitAction(
  engine: Engine,
  action: Apicity014Action,
  job: Apicity014JobPayload,
  ctx: JobHandlerContext,
  ownerId?: string,
): Promise<string> {
  const prompt = transformProviderPrompt(action.canonicalName, job.args);
  const media = await resolveJobMedia(engine, action, { ...job.args, ...(prompt === undefined ? {} : { prompt }) });
  const payload = parsedPayload(action, media.args);
  const meta = generationMeta(job.args, action, media);
  if (action.provider === "kie") {
    return submitKieTask(engine, ctx, {
      request: payload as unknown as MediaGenerationRequest,
      taskType: action.taskType,
      assetId: job.assetId,
      assetDir: job.assetDir,
      bookId: job.bookId,
      meta,
    });
  }
  if (!action.taskType.startsWith("fal_")) {
    throw new Error(`fal task type must start with fal_: ${action.taskType}`);
  }
  if (!ownerId) throw new Error(`Missing fal lease owner for ${action.canonicalName}`);
  return submitFalJob({
    engine,
    bookId: job.bookId,
    assetId: job.assetId,
    assetDir: job.assetDir,
    endpointId: action.endpointId,
    input: payload,
    taskType: action.taskType as `fal_${string}`,
    meta,
    expectedOwnerId: ownerId,
  });
}

export function registerApicity014Jobs(engine: Engine): void {
  for (const listed of apicity014Actions()) {
    const action = apicity014Action(listed.canonicalName);
    if (!action) throw new Error(`Missing apicity 0.14.1 job for ${listed.canonicalName}`);
    registerJobHandler(action.jobType, async (payload, ctx) => {
      const job = payload as Apicity014JobPayload;
      if (action.provider === "fal") {
        return withProviderHandoff(engine, job.assetId, ctx, "generate", async (ownerId) => {
          const taskId = await submitAction(engine, action, job, ctx, ownerId);
          return { taskId, result: { success: true, taskId } };
        });
      }
      const taskId = await submitAction(engine, action, job, ctx);
      return { success: true, taskId };
    });
  }
}
