import type { MediaGenerationRequest } from "@apicity/kie";
import { kie, submitMediaJob } from "@apicity/kie";
import { canonicalHash, computeEstimate } from "@apicity/cost";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JobHandlerContext } from "../queue.js";
import { QUEUED_TASK_ID } from "vc-engine";
import type { PendingTask, TaskType, VideocityFs } from "vc-engine";
import { requireApiKey } from "../api-key.js";

export const KIE_PAYGATE_DOT_PATH = "api.v1.jobs.createTask";

type SubmitKieTaskArgs = {
  request: MediaGenerationRequest;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  taskType: TaskType;
  meta: Record<string, unknown>;
};

type KeyPaths = {
  privateKeyPath: string;
  publicKeyPath: string;
};

function base64urlEncode(data: Buffer): string {
  return data
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function defaultPrivateKeyPath(): string {
  return join(homedir(), ".videocity", "paygate-private.pem");
}

function defaultPublicKeyPath(): string {
  return join(homedir(), ".videocity", "paygate-public.pem");
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

function derivePublicKey(privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

export function ensurePaygateKeyPaths(): KeyPaths {
  const configuredPrivate = process.env.APICITY_PAYGATE_PRIVATE_KEY_PATH;
  const configuredPublic = process.env.APICITY_PAYGATE_PUBLIC_KEY_PATH;
  if (configuredPrivate && configuredPublic) {
    return { privateKeyPath: configuredPrivate, publicKeyPath: configuredPublic };
  }
  if (!configuredPrivate && configuredPublic) {
    throw new Error("APICITY_PAYGATE_PRIVATE_KEY_PATH is required when APICITY_PAYGATE_PUBLIC_KEY_PATH is set");
  }

  const privateKeyPath = configuredPrivate ?? defaultPrivateKeyPath();
  const publicKeyPath = configuredPublic ?? (configuredPrivate ? `${privateKeyPath}.pub` : defaultPublicKeyPath());

  if (configuredPrivate) {
    const privateKeyPem = readFileSync(privateKeyPath, "utf8");
    writeKey(publicKeyPath, derivePublicKey(privateKeyPem), 0o644);
    process.env.APICITY_PAYGATE_PUBLIC_KEY_PATH = publicKeyPath;
    return { privateKeyPath, publicKeyPath };
  }

  if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeKey(privateKeyPath, privateKey, 0o600);
    writeKey(publicKeyPath, publicKey, 0o644);
  }

  process.env.APICITY_PAYGATE_PRIVATE_KEY_PATH = privateKeyPath;
  process.env.APICITY_PAYGATE_PUBLIC_KEY_PATH = publicKeyPath;
  return { privateKeyPath, publicKeyPath };
}

export function mintKieOtp(request: MediaGenerationRequest, ttlSeconds = 10 * 60): string {
  const { privateKeyPath } = ensurePaygateKeyPaths();
  const payload = request as unknown as Record<string, unknown>;
  const estimate = computeEstimate({ provider: "kie", payload });
  if (estimate.warnings.length > 0) {
    throw new Error(`KIE cost estimate is not bounded: ${estimate.warnings.join("; ")}`);
  }

  const iat = Math.floor(Date.now() / 1000);
  const otpPayload = {
    v: 1,
    jti: randomBytes(16).toString("hex"),
    provider: "kie",
    method: "POST",
    dotPath: KIE_PAYGATE_DOT_PATH,
    requestHash: canonicalHash(request),
    maxSpendUsd: estimate.usd,
    iat,
    exp: iat + ttlSeconds,
  };
  const payloadSegment = base64urlEncode(Buffer.from(JSON.stringify(otpPayload), "utf8"));
  const privateKeyPem = readFileSync(privateKeyPath, "utf8");
  const signatureSegment = base64urlEncode(sign(null, Buffer.from(payloadSegment, "utf8"), privateKeyPem));
  return `${payloadSegment}.${signatureSegment}`;
}

export async function submitKieTask(
  fs: VideocityFs,
  ctx: JobHandlerContext,
  args: SubmitKieTaskArgs,
): Promise<string> {
  const apiKey = requireApiKey("KIE_API_KEY");
  await fs.writeMetadata(args.assetId, "generation-payload", args.request, args.projectSlug);
  const provider = kie({ apiKey, timeout: 60_000 });
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
  const provider = kie({ apiKey, timeout: 60_000 });
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
