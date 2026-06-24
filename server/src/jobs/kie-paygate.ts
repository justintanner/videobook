import type { MediaGenerationRequest } from "@apicity/kie";
import { createKie, submitMediaJob } from "@apicity/kie";
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

// Local shim: @apicity/cost@0.6.0 has no rate for the Volcengine v2v lip-sync,
// OmniHuman 1.5, HappyHorse 1.1, or Seedance 2 Mini models shipped in
// @apicity/kie, so computeEstimate flags them as unbounded. The paygate only
// binds the request hash — it never recomputes cost downstream — so admitting
// these models here is safe. (HappyHorse 1.1 rates match the priced 1.0
// happyhorse/* endpoints; the cost-display estimator keys off those — see
// cost-adapters.ts. Seedance 2 Mini has no priced sibling and surfaces as "—".)
// Remove each entry once @apicity/cost prices the corresponding model.
const COST_TABLE_PENDING_MODELS = new Set<string>([
  "volcengine/video-to-video-lip-sync",
  "omnihuman-1-5",
  "happyhorse-1-1/text-to-video",
  "happyhorse-1-1/image-to-video",
  "happyhorse-1-1/reference-to-video",
  "bytedance/seedance-2-mini",
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

export function mintKieOtp(request: MediaGenerationRequest, ttlSeconds = 10 * 60): string {
  const payload = request as unknown as Record<string, unknown>;
  const model = typeof payload.model === "string" ? payload.model : "";
  const estimate = computeEstimate({ provider: "kie", payload });
  if (estimate.warnings.length > 0 && !COST_TABLE_PENDING_MODELS.has(model)) {
    throw new Error(`KIE cost estimate is not bounded: ${estimate.warnings.join("; ")}`);
  }

  return mintOtp(ensurePaygateSecret(), {
    provider: "kie",
    method: "POST",
    dotPath: KIE_PAYGATE_DOT_PATH,
    request: payload,
    ttl: ttlSeconds,
  });
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
