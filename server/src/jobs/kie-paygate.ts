import type { MediaGenerationRequest, VeoGenerateRequest } from "@apicity/kie";
import { createKie, submitMediaJob, KieError } from "@apicity/kie";
import { computeEstimate, mintOtp } from "@apicity/cost";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JobHandlerContext } from "../queue.js";
import { QUEUED_TASK_ID } from "videobook-engine";
import type { PendingTask, TaskType, Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { normalizeKieCostPayload, type KieCostHints } from "../cost-adapters.js";
import { estimateMiniMaxH3WireCost } from "../minimax-h3-cost.js";
import { assertProviderPayload } from "../provider-prompt-transform.js";

export const KIE_PAYGATE_DOT_PATH = "api.v1.jobs.createTask";
export const VEO_PAYGATE_DOT_PATH = "api.v1.veo.generate";

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
  costHints: KieCostHints = {},
): string {
  const payload = request as unknown as Record<string, unknown>;
  const normalized = normalizeKieCostPayload(payload, costHints);
  const estimate = computeEstimate({ provider: "kie", payload: normalized });
  // A local ceiling stands in only where @apicity/cost cannot price the model
  // at all (MiniMax H3, docs/apicity-gaps.md §35). Consulting it strictly after
  // computeEstimate keeps the package authoritative: the moment it ships those
  // rates, this branch stops being reached.
  if (estimate.warnings.length > 0 && estimateMiniMaxH3WireCost(normalized) === null) {
    throw new Error(`KIE cost estimate is not bounded: ${estimate.warnings.join("; ")}`);
  }

  // The OTP hashes the wire payload verbatim — costHints never enter the hash,
  // so the request that hits Kie carries only its documented schema fields.
  return mintOtp(ensurePaygateSecret(), {
    provider: "kie",
    method: "POST",
    dotPath,
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
  fs: Engine,
  ctx: JobHandlerContext,
  args: SubmitKieTaskArgs,
): Promise<string> {
  assertProviderPayload(args.request, {
    toolName: args.taskType,
    wire: true,
  });
  const apiKey = requireApiKey("KIE_API_KEY");
  await fs.metadata.artifacts.write(args.assetId, "generation-payload", args.request);
  if (args.costHints) {
    await fs.metadata.artifacts.write(args.assetId, "generation-cost-hints", args.costHints);
  }
  const provider = createKieProvider(apiKey);
  const taskId = await submitMediaJob(provider, args.request, { otp: mintKieOtp(args.request, 10 * 60, KIE_PAYGATE_DOT_PATH, args.costHints) });

  const pendingResult = await fs.jobs.pending.write({
    taskId,
    taskType: args.taskType,
    artifactId: args.assetId,
    meta: args.meta,
  }, ctx.getOwnerId());
  if (!pendingResult.ok) throw new Error(`Failed to write pending-task for ${args.assetId}: ${pendingResult.error.message}`);
  if (pendingResult.value === null) throw new Error(`Lost local lease while writing pending-task`);

  await fs.metadata.artifacts.write(args.assetId, "kie-task-id", { taskId });
  ctx.setLease({ kind: "task", taskId });
  return taskId;
}

export async function submitQueuedKieTask(
  fs: Engine,
  bookId: string,
  task: PendingTask,
): Promise<PendingTask> {
  if (task.taskId !== QUEUED_TASK_ID) throw new Error(`KIE task ${task.artifactId} is not locally queued`);
  const ownerId = await fs.jobs.pending.getOwner(task.artifactId, QUEUED_TASK_ID);
  if (!ownerId) throw new Error(`No active queued KIE lease found for ${task.artifactId}`);

  const payloadResult = await fs.metadata.artifacts.read<MediaGenerationRequest>(task.artifactId, "generation-payload");
  if (!payloadResult.ok || payloadResult.value === null) throw new Error(`No prepared KIE payload found for ${task.artifactId}`);
  assertProviderPayload(payloadResult.value, {
    toolName: task.taskType,
    wire: true,
  });

  // Reload persisted cost hints (if any) so the OTP minted on resubmission
  // sees the same duration the original handler resolved, without leaking it
  // into the wire payload.
  const hintsResult = await fs.metadata.artifacts.read<KieCostHints>(task.artifactId, "generation-cost-hints");
  const costHints = hintsResult.ok && hintsResult.value ? hintsResult.value : {};

  const apiKey = requireApiKey("KIE_API_KEY");
  const provider = createKieProvider(apiKey);
  const taskId = await submitMediaJob(provider, payloadResult.value, { otp: mintKieOtp(payloadResult.value, 10 * 60, KIE_PAYGATE_DOT_PATH, costHints) });
  const meta = { ...task.meta };
  delete meta.kiePaygate;
  const writeResult = await fs.jobs.pending.write({
    taskId,
    taskType: task.taskType,
    artifactId: task.artifactId,
    meta,
  }, ownerId);
  if (!writeResult.ok) throw new Error(`Failed to write submitted pending-task for ${task.artifactId}: ${writeResult.error.message}`);
  if (writeResult.value === null) throw new Error(`Lost queued KIE lease while submitting ${task.artifactId}`);

  await fs.metadata.artifacts.write(task.artifactId, "kie-task-id", { taskId });
  return writeResult.value.task;
}

type SubmitVeoTaskArgs = {
  request: VeoGenerateRequest;
  assetId: string;
  assetDir: string;
  bookId: string;
  taskType: TaskType;
  meta: Record<string, unknown>;
};

/** Submit a Veo 3 / Veo 3 Fast generation task. Veo uses a separate kie
 *  namespace (`kie.veo.post.api.v1.veo.generate`) and paygate dotPath
 *  (`api.v1.veo.generate`) from the standard `jobs.createTask` path. */
export async function submitVeoTask(
  fs: Engine,
  ctx: JobHandlerContext,
  args: SubmitVeoTaskArgs,
): Promise<string> {
  assertProviderPayload(args.request, {
    toolName: args.taskType,
    wire: true,
  });
  const apiKey = requireApiKey("KIE_API_KEY");
  await fs.metadata.artifacts.write(args.assetId, "generation-payload", args.request);
  const provider = createKieProvider(apiKey);

  const result = await provider.veo.post.api.v1.veo.generate(args.request, {
    otp: mintKieOtp(args.request as unknown as MediaGenerationRequest, 10 * 60, VEO_PAYGATE_DOT_PATH, {}),
  });
  if (!result.data?.taskId) {
    throw new KieError(
      `veo.generate failed: ${result.code} ${typeof result === "object" && result !== null && "msg" in result ? String((result as { msg?: unknown }).msg) : "no taskId in response"}`,
      result.code,
    );
  }
  const taskId = result.data.taskId;

  const pendingResult = await fs.jobs.pending.write({
    taskId,
    taskType: args.taskType,
    artifactId: args.assetId,
    meta: args.meta,
  }, ctx.getOwnerId());
  if (!pendingResult.ok) throw new Error(`Failed to write pending-task for ${args.assetId}: ${pendingResult.error.message}`);
  if (pendingResult.value === null) throw new Error(`Lost local lease while writing pending-task`);

  await fs.metadata.artifacts.write(args.assetId, "kie-task-id", { taskId });
  ctx.setLease({ kind: "task", taskId });
  return taskId;
}
