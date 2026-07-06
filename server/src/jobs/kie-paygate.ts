import type { MediaGenerationRequest, VeoGenerateRequest } from "@apicity/kie";
import { createKie, submitMediaJob, KieError } from "@apicity/kie";
import { computeEstimate, mintOtp } from "@apicity/cost";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JobHandlerContext } from "../queue.js";
import { QUEUED_TASK_ID } from "videocity-engine";
import type { PendingTask, TaskType, VideocityFs } from "videocity-engine";
import { requireApiKey } from "../api-key.js";

export const KIE_PAYGATE_DOT_PATH = "api.v1.jobs.createTask";
export const VEO_PAYGATE_DOT_PATH = "api.v1.veo.generate";

// Local shim: @apicity/cost has no rate for the Volcengine v2v lip-sync,
// OmniHuman 1.5, or Gemini Omni Video models shipped in @apicity/kie, so
// computeEstimate flags them as unbounded. The paygate only binds the request
// hash — it never recomputes cost downstream — so admitting these models here
// is safe. (Gemini Omni Video has no priced rate and surfaces as "—" in the
// UI.) Remove each entry once @apicity/cost prices the corresponding model.
// HappyHorse 1.1 and Seedance 2 Mini were removed here once cost@0.6.1 priced
// them directly (see cost-adapters.ts + docs/apicity-gaps.md §9/§10).
const COST_TABLE_PENDING_MODELS = new Set<string>([
  "volcengine/video-to-video-lip-sync",
  "omnihuman-1-5",
  "gemini-omni-video",
]);

type SubmitKieTaskArgs = {
  request: MediaGenerationRequest;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  taskType: TaskType;
  meta: Record<string, unknown>;
};

function defaultSecretPath(): string {
  return join(homedir(), ".videocity", "paygate-secret");
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
): string {
  const payload = request as unknown as Record<string, unknown>;
  const estimate = computeEstimate({ provider: "kie", payload });
  if (estimate.warnings.length > 0 && !COST_TABLE_PENDING_MODELS.has(modelOf(payload))) {
    throw new Error(`KIE cost estimate is not bounded: ${estimate.warnings.join("; ")}`);
  }

  return mintOtp(ensurePaygateSecret(), {
    provider: "kie",
    method: "POST",
    dotPath,
    request: payload,
    ttl: ttlSeconds,
  });
}

function modelOf(payload: Record<string, unknown>): string {
  const model = payload.model;
  return typeof model === "string" ? model : "";
}

function createKieProvider(apiKey: string) {
  return createKie({
    apiKey,
    timeout: 60_000,
    paygate: { secret: ensurePaygateSecret() },
  });
}

export async function submitKieTask(
  fs: VideocityFs,
  ctx: JobHandlerContext,
  args: SubmitKieTaskArgs,
): Promise<string> {
  const apiKey = requireApiKey("KIE_API_KEY");
  await fs.writeMetadata(args.assetId, "generation-payload", args.request, args.projectSlug);
  const provider = createKieProvider(apiKey);
  const taskId = await submitMediaJob(provider, args.request, { otp: mintKieOtp(args.request) });

  const pendingResult = await fs.pendingTasks.write(args.projectSlug, {
    taskId,
    taskType: args.taskType,
    assetId: args.assetId,
    assetDir: args.assetDir,
    meta: args.meta,
  }, ctx.getOwnerId());
  if (!pendingResult.ok) throw new Error(`Failed to write pending-task for ${args.assetId}: ${pendingResult.error.message}`);
  if (pendingResult.value === null) throw new Error(`Lost local lease while writing pending-task`);

  await fs.writeMetadata(args.assetId, "kie-task-id", { taskId }, args.projectSlug);
  ctx.setLease({ kind: "task", taskId });
  return taskId;
}

export async function submitQueuedKieTask(
  fs: VideocityFs,
  projectSlug: string,
  task: PendingTask,
): Promise<PendingTask> {
  if (task.taskId !== QUEUED_TASK_ID) throw new Error(`KIE task ${task.assetId} is not locally queued`);
  const ownerId = await fs.pendingTasks.getOwner(projectSlug, task.assetId, QUEUED_TASK_ID);
  if (!ownerId) throw new Error(`No active queued KIE lease found for ${task.assetId}`);

  const payloadResult = await fs.readMetadata<MediaGenerationRequest>(task.assetId, "generation-payload", projectSlug);
  if (!payloadResult.ok || payloadResult.value === null) throw new Error(`No prepared KIE payload found for ${task.assetId}`);

  const apiKey = requireApiKey("KIE_API_KEY");
  const provider = createKieProvider(apiKey);
  const taskId = await submitMediaJob(provider, payloadResult.value, { otp: mintKieOtp(payloadResult.value) });
  const meta = { ...task.meta };
  delete meta.kiePaygate;
  const writeResult = await fs.pendingTasks.write(projectSlug, {
    taskId,
    taskType: task.taskType,
    assetId: task.assetId,
    assetDir: task.assetDir,
    meta,
  }, ownerId);
  if (!writeResult.ok) throw new Error(`Failed to write submitted pending-task for ${task.assetId}: ${writeResult.error.message}`);
  if (writeResult.value === null) throw new Error(`Lost queued KIE lease while submitting ${task.assetId}`);

  await fs.writeMetadata(task.assetId, "kie-task-id", { taskId }, projectSlug);
  return writeResult.value.pendingTask;
}

type SubmitVeoTaskArgs = {
  request: VeoGenerateRequest;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  taskType: TaskType;
  meta: Record<string, unknown>;
};

/** Submit a Veo 3 / Veo 3 Fast generation task. Veo uses a separate kie
 *  namespace (`kie.veo.post.api.v1.veo.generate`) and paygate dotPath
 *  (`api.v1.veo.generate`) from the standard `jobs.createTask` path. */
export async function submitVeoTask(
  fs: VideocityFs,
  ctx: JobHandlerContext,
  args: SubmitVeoTaskArgs,
): Promise<string> {
  const apiKey = requireApiKey("KIE_API_KEY");
  await fs.writeMetadata(args.assetId, "generation-payload", args.request, args.projectSlug);
  const provider = createKieProvider(apiKey);

  const result = await provider.veo.post.api.v1.veo.generate(args.request, {
    otp: mintKieOtp(args.request as unknown as MediaGenerationRequest, 10 * 60, VEO_PAYGATE_DOT_PATH),
  });
  if (!result.data?.taskId) {
    throw new KieError(
      `veo.generate failed: ${result.code} ${typeof result === "object" && result !== null && "msg" in result ? String((result as { msg?: unknown }).msg) : "no taskId in response"}`,
      result.code,
    );
  }
  const taskId = result.data.taskId;

  const pendingResult = await fs.pendingTasks.write(args.projectSlug, {
    taskId,
    taskType: args.taskType,
    assetId: args.assetId,
    assetDir: args.assetDir,
    meta: args.meta,
  }, ctx.getOwnerId());
  if (!pendingResult.ok) throw new Error(`Failed to write pending-task for ${args.assetId}: ${pendingResult.error.message}`);
  if (pendingResult.value === null) throw new Error(`Lost local lease while writing pending-task`);

  await fs.writeMetadata(args.assetId, "kie-task-id", { taskId }, args.projectSlug);
  ctx.setLease({ kind: "task", taskId });
  return taskId;
}
