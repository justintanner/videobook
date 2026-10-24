import { withHarLocalFailure } from "../har-capture.js";
import { createKie } from "../usage-providers.js";
import type { MediaGenerationRequest } from "@apicity/kie";
import { submitMediaJob } from "../usage-providers.js";
import { mintOtp } from "@apicity/cost";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JobHandlerContext } from "../queue.js";
import { QUEUED_TASK_ID } from "videobook-engine";
import type { PendingTask, TaskType, Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { referenceVideoDuration } from "../reference-video-duration.js";
import { assertProviderPayload } from "../provider-prompt-transform.js";
import {
  assessKieRequestEstimate,
  logUnavailableCostEstimate,
  type CostEstimateAssessment,
  type CostEstimateLogContext,
  type KieCostHints,
} from "./cost-estimate-assessment.js";

export const KIE_PAYGATE_DOT_PATH = "api.v1.jobs.createTask";

type SubmitKieTaskArgs = {
  request: MediaGenerationRequest;
  assetId: string;
  assetDir: string;
  bookId: string;
  taskType: TaskType;
  meta: Record<string, unknown>;
  // Out-of-band cost hints (see KieCostHints). Persisted alongside the
  // generation-payload so submitQueuedKieTask can re-bound the OTP after a
  // local-queue→submit transition without polluting the wire payload.
  costHints?: KieCostHints;
};

function defaultSecretPath(): string {
  return join(homedir(), ".videobook", "paygate-secret");
}

function writeKey(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8", mode });
  try {
    chmodSync(path, mode);
  } catch {
    return;
  }
}

export function ensurePaygateSecret(): string {
  const configuredSecret = process.env.APICITY_PAYGATE_SECRET?.trim();
  if (configuredSecret) return configuredSecret;

  const secretPath = process.env.APICITY_PAYGATE_SECRET_PATH ?? defaultSecretPath();
  if (!existsSync(secretPath)) {
    writeKey(secretPath, `${randomBytes(32).toString("base64url")}\n`, 0o600);
  }

  const secret = readFileSync(secretPath, "utf8").trim();
  if (!secret) {
    throw new Error(`APICITY paygate secret is empty: ${secretPath}`);
  }
  process.env.APICITY_PAYGATE_SECRET_PATH = secretPath;
  return secret;
}

export function mintKieOtp(
  request: MediaGenerationRequest,
  ttlSeconds = 10 * 60,
  dotPath: string = KIE_PAYGATE_DOT_PATH,
  _costHints: KieCostHints = {},
): string {
  const payload = request as unknown as Record<string, unknown>;
  // The OTP hashes the wire payload verbatim — costHints never enter the hash,
  // so the request that hits Kie carries only its documented schema fields.
  // Cost estimation is advisory and must not gate minting.
  return mintOtp(ensurePaygateSecret(), {
    provider: "kie",
    method: "POST",
    dotPath,
    request: payload,
    ttl: ttlSeconds,
  });
}

export async function authorizeKiePaygate(
  request: MediaGenerationRequest,
  options: {
    ttlSeconds?: number;
    dotPath?: string;
    costHints?: KieCostHints;
    engine?: Engine;
    correlation?: CostEstimateLogContext;
  } = {},
): Promise<{ otp: string; assessment: CostEstimateAssessment }> {
  const costHints = options.costHints ?? {};
  const assessment = assessKieRequestEstimate(request, costHints);
  if (!assessment.available) {
    const model = typeof (request as { model?: unknown }).model === "string"
      ? (request as { model: string }).model
      : options.correlation?.model;
    await logUnavailableCostEstimate({
      assessment,
      engine: options.engine,
      correlation: {
        provider: "kie",
        ...options.correlation,
        ...(model ? { model } : {}),
      },
    });
  }
  return {
    otp: mintKieOtp(
      request,
      options.ttlSeconds,
      options.dotPath,
      costHints,
    ),
    assessment,
  };
}

function createKieProvider(apiKey: string) {
  return createKie({
    apiKey,
    timeout: 60_000,
    paygate: { secret: ensurePaygateSecret() },
  });
}

async function submitKieTaskInner(
  engine: Engine,
  ctx: JobHandlerContext,
  args: SubmitKieTaskArgs,
): Promise<string> {
  const request = args.request;
  assertProviderPayload(request, {
    toolName: args.taskType,
    wire: true,
  });
  const apiKey = requireApiKey("KIE_API_KEY");
  await engine.metadata.artifacts.write(args.assetId, "generation-payload", request);
  const costHints = { ...args.costHints };
  const requestInput = request.input as Record<string, unknown>;
  const videoUrls = requestInput.reference_video_urls;
  const sourceVideoIds = args.meta.sourceVideoIds;
  if (costHints.inputDuration === undefined && Array.isArray(videoUrls) && videoUrls.length > 0
    && Array.isArray(sourceVideoIds) && sourceVideoIds.length === videoUrls.length
    && sourceVideoIds.every((id): id is string => typeof id === "string")) {
    const duration = await referenceVideoDuration(engine, sourceVideoIds);
    if (duration !== undefined) costHints.inputDuration = duration;
  }
  if (Object.keys(costHints).length > 0) {
    await engine.metadata.artifacts.write(args.assetId, "generation-cost-hints", costHints);
  }
  const provider = createKieProvider(apiKey);
  const { otp } = await authorizeKiePaygate(request, {
    costHints,
    engine,
    correlation: {
      bookId: args.bookId,
      artifactId: args.assetId,
      tool: args.taskType,
      stage: "submit-kie",
    },
  });
  const taskId = await submitMediaJob(provider, request, { otp });

  const pendingResult = await engine.jobs.pending.write({
    taskId,
    taskType: args.taskType,
    artifactId: args.assetId,
    meta: args.meta,
  }, ctx.getOwnerId());
  if (!pendingResult.ok) throw new Error(`Failed to write pending-task for ${args.assetId}: ${pendingResult.error.message}`);
  if (pendingResult.value === null) throw new Error(`Lost local lease while writing pending-task`);

  await engine.metadata.artifacts.write(args.assetId, "kie-task-id", { taskId });
  ctx.setLease({ kind: "task", taskId });
  return taskId;
}

async function submitQueuedKieTaskInner(
  engine: Engine,
  task: PendingTask,
): Promise<PendingTask> {
  if (task.taskId !== QUEUED_TASK_ID) throw new Error(`KIE task ${task.artifactId} is not locally queued`);
  const ownerId = await engine.jobs.pending.getOwner(task.artifactId, QUEUED_TASK_ID);
  if (!ownerId) throw new Error(`No active queued KIE lease found for ${task.artifactId}`);

  const payloadResult = await engine.metadata.artifacts.read<MediaGenerationRequest>(task.artifactId, "generation-payload");
  if (!payloadResult.ok || payloadResult.value === null) throw new Error(`No prepared KIE payload found for ${task.artifactId}`);
  const request = payloadResult.value;
  assertProviderPayload(request, {
    toolName: task.taskType,
    wire: true,
  });

  // Reload persisted cost hints (if any) so the OTP minted on resubmission
  // sees the same duration the original handler resolved, without leaking it
  // into the wire payload.
  const hintsResult = await engine.metadata.artifacts.read<KieCostHints>(task.artifactId, "generation-cost-hints");
  const costHints = hintsResult.ok && hintsResult.value ? hintsResult.value : {};

  const apiKey = requireApiKey("KIE_API_KEY");
  const provider = createKieProvider(apiKey);
  const { otp } = await authorizeKiePaygate(request, {
    costHints,
    engine,
    correlation: {
      artifactId: task.artifactId,
      tool: task.taskType,
      stage: "submit-queued-kie",
    },
  });
  const taskId = await submitMediaJob(provider, request, { otp });
  const meta = { ...task.meta };
  delete meta.kiePaygate;
  const writeResult = await engine.jobs.pending.write({
    taskId,
    taskType: task.taskType,
    artifactId: task.artifactId,
    meta,
  }, ownerId);
  if (!writeResult.ok) throw new Error(`Failed to write submitted pending-task for ${task.artifactId}: ${writeResult.error.message}`);
  if (writeResult.value === null) throw new Error(`Lost queued KIE lease while submitting ${task.artifactId}`);

  await engine.metadata.artifacts.write(task.artifactId, "kie-task-id", { taskId });
  return writeResult.value.task;
}

export async function submitKieTask(engine: Engine, ctx: JobHandlerContext, args: SubmitKieTaskArgs): Promise<string> {
  return withHarLocalFailure({ provider: "kie", endpoint: "api.v1.jobs.createTask", input: args.request }, () => submitKieTaskInner(engine, ctx, args));
}

export async function submitQueuedKieTask(engine: Engine, task: PendingTask): Promise<PendingTask> {
  return withHarLocalFailure({ provider: "kie", endpoint: "api.v1.jobs.createTask", input: task }, () => submitQueuedKieTaskInner(engine, task));
}
