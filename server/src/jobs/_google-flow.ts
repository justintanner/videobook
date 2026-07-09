import { createGoogleFlow, GoogleFlowError } from "@apicity/googleflow";
import type { GoogleFlowVideosRequest, GoogleFlowProvider } from "@apicity/googleflow";
import type { TaskType, VideocityFs } from "videocity-engine";
import type { JobHandlerContext } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { prepareAssetForUpload, prepareBytesForUpload } from "../upload.js";

export const GOOGLE_FLOW_ENV_KEY = "GOOGLE_FLOW_API_KEY";

// The synchronous google-flow endpoints (images) block until Google Flow
// finishes rendering — useapi.net polls up to 10 minutes server-side before
// returning 408 — so the client timeout must comfortably cover that window.
const GOOGLE_FLOW_TIMEOUT_MS = 10 * 60_000;

// useapi default captchaRetry is 5; we raise it so flaky reCAPTCHA scores
// (PUBLIC_ERROR_UNUSUAL_ACTIVITY_*) get more provider attempts before 429.
// Max allowed by the schema is 10. Override with GOOGLE_FLOW_CAPTCHA_RETRY.
export const DEFAULT_GOOGLE_FLOW_CAPTCHA_RETRY = 8;

// After a captcha_quality 429/403 exhausts captchaRetry, wait once and resubmit
// the whole request — Google traffic reputation often clears within a minute.
const CAPTCHA_SUBMIT_RETRY_DELAY_MS = 15_000;
const CAPTCHA_SUBMIT_MAX_ATTEMPTS = 2;

// @apicity/googleflow@0.7.1 percent-encodes path IDs (encodeURIComponent on
// jobId / mediaGenerationId / email / ref), but useapi.net IDs carry ':' and
// '@' that must reach the server RAW — an encoded jobid returns 400 "Invalid
// job ID format". This fetch hook undoes the over-encoding on the pathname so
// jobs.retrieve polling works. Upstream bug; see docs/apicity-gaps.md §16.
export function googleFlowFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof input === "string") {
    try {
      const u = new URL(input);
      const rawPath = decodeURIComponent(u.pathname);
      if (rawPath !== u.pathname) input = `${u.origin}${rawPath}${u.search}`;
    } catch {
      // not a parseable URL — pass through untouched
    }
  }
  return fetch(input, init);
}
// @apicity/googleflow is the dedicated useapi.net Google Flow provider (split
// out of @apicity/google in 0.7.1, which now hosts only Vertex express-mode
// / Gemini content calls). It takes a single apiKey — the same useapi.net
// GOOGLE_FLOW_API_KEY token — for every Flow endpoint.
export function createGoogleFlowProvider(timeoutMs: number = GOOGLE_FLOW_TIMEOUT_MS): GoogleFlowProvider {
  const apiKey = requireApiKey(GOOGLE_FLOW_ENV_KEY);
  return createGoogleFlow({ apiKey, timeout: timeoutMs, fetch: googleFlowFetch });
}

export function resolveGoogleFlowCaptchaRetry(): number {
  const raw = process.env.GOOGLE_FLOW_CAPTCHA_RETRY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GOOGLE_FLOW_CAPTCHA_RETRY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_GOOGLE_FLOW_CAPTCHA_RETRY;
  return Math.min(10, Math.max(1, Math.trunc(n)));
}

/** Stamp captchaRetry (and optional captchaOrder from env) unless the caller
 *  already set a captcha field. captchaToken is left alone — a user-supplied
 *  token is mutually exclusive with provider-based retry. */
export function withGoogleFlowCaptchaDefaults<T extends Record<string, unknown>>(request: T): T {
  if (
    request.captchaToken !== undefined
    || request.captchaRetry !== undefined
    || request.captchaOrder !== undefined
  ) {
    return request;
  }
  const captchaOrder = process.env.GOOGLE_FLOW_CAPTCHA_ORDER?.trim();
  return {
    ...request,
    captchaRetry: resolveGoogleFlowCaptchaRetry(),
    ...(captchaOrder ? { captchaOrder } : {}),
  };
}

export function isCaptchaQualityGoogleFlowError(error: unknown): boolean {
  if (!(error instanceof GoogleFlowError)) return false;
  const msg = error.message;
  if (msg.includes("captcha_quality")) return true;
  if (typeof error.body === "object" && error.body !== null) {
    const bodyError = (error.body as Record<string, unknown>).error;
    if (typeof bodyError === "string" && bodyError.includes("captcha_quality")) return true;
  }
  return false;
}

function extractGoogleFlowOperationErrors(job: Record<string, unknown>): string[] {
  const response = job.response;
  if (!response || typeof response !== "object") return [];
  const res = response as Record<string, unknown>;

  const operations = res.operations;
  if (Array.isArray(operations)) {
    const msgs: string[] = [];
    for (const entry of operations) {
      if (!entry || typeof entry !== "object") continue;
      const operation = (entry as Record<string, unknown>).operation;
      if (!operation || typeof operation !== "object") continue;
      const err = (operation as Record<string, unknown>).error;
      if (!err || typeof err !== "object") continue;
      const message = (err as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim() !== "") msgs.push(message.trim());
    }
    if (msgs.length > 0) return msgs;
  }

  const nested = res.error;
  if (nested && typeof nested === "object") {
    const details = (nested as Record<string, unknown>).details;
    if (Array.isArray(details)) {
      const reasons: string[] = [];
      for (const d of details) {
        if (!d || typeof d !== "object") continue;
        const reason = (d as Record<string, unknown>).reason;
        if (typeof reason === "string" && reason.trim() !== "") reasons.push(reason.trim());
      }
      if (reasons.length > 0) return reasons;
    }
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim() !== "") return [message.trim()];
  }

  return [];
}

/** Prefer the top-level job.error string, then append nested operation /
 *  policy reasons (e.g. PUBLIC_ERROR_MINOR) so cards show more than
 *  "All operations failed". */
export function formatGoogleFlowJobError(job: Record<string, unknown>): string {
  const base = typeof job.error === "string" && job.error.trim() !== ""
    ? job.error.trim()
    : "Google Flow job failed";
  const nested = extractGoogleFlowOperationErrors(job);
  if (nested.length === 0) return base;
  const detail = nested.join("; ");
  if (base.includes(detail)) return base;
  return `${base}: ${detail}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Call a Google Flow endpoint with captcha defaults and one delayed resubmit
 *  on captcha_quality failures. */
export async function callGoogleFlowWithCaptchaRetry<T>(
  call: (request: Record<string, unknown>) => Promise<T>,
  request: Record<string, unknown>,
  opts?: { sleepMs?: number; maxAttempts?: number },
): Promise<T> {
  const body = withGoogleFlowCaptchaDefaults(request);
  const maxAttempts = opts?.maxAttempts ?? CAPTCHA_SUBMIT_MAX_ATTEMPTS;
  const delayMs = opts?.sleepMs ?? CAPTCHA_SUBMIT_RETRY_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await call(body);
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts && isCaptchaQualityGoogleFlowError(e)) {
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// POST /google-flow/assets nests the reference id one level down:
// { mediaGenerationId: { mediaGenerationId: "user:…-image:…" }, … }.
function readMediaGenerationId(res: Record<string, unknown>): string | null {
  const outer = res.mediaGenerationId;
  if (typeof outer === "string") return outer;
  if (outer && typeof outer === "object") {
    const inner = (outer as Record<string, unknown>).mediaGenerationId;
    if (typeof inner === "string") return inner;
  }
  return null;
}

async function uploadBytesToGoogleFlow(
  provider: GoogleFlowProvider,
  data: Uint8Array,
  contentType: string,
  label: string,
): Promise<string> {
  const body = new Blob([new Uint8Array(data)], { type: contentType });
  const res = await provider.v1.assets({ body, contentType });
  const mediaGenerationId = readMediaGenerationId(res as Record<string, unknown>);
  if (!mediaGenerationId) {
    throw new Error(`Google Flow asset upload returned no mediaGenerationId for ${label}`);
  }
  return mediaGenerationId;
}

// Upload a project asset file as a Google Flow reference asset. Unlike the
// kie/fal upload helpers this returns a mediaGenerationId, not a URL —
// google-flow requests reference prior uploads by id.
export async function uploadAssetToGoogleFlow(
  provider: GoogleFlowProvider,
  fs: VideocityFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string> {
  const { data, contentType } = await prepareAssetForUpload(fs, assetId, filename, projectSlug);
  return uploadBytesToGoogleFlow(provider, data, contentType, `${assetId}/${filename}`);
}

// Upload an external http(s) image (ephemeral inputs that never became
// project assets) by fetching its bytes first.
export async function uploadUrlToGoogleFlow(provider: GoogleFlowProvider, url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch reference image ${url}: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const filename = new URL(url).pathname.split("/").pop() || "reference.png";
  const { data, contentType } = await prepareBytesForUpload(bytes, filename);
  return uploadBytesToGoogleFlow(provider, data, contentType, url);
}

// The async submit (201) answers with `jobid`; the sync shape uses `jobId`.
function readJobId(res: Record<string, unknown>): string | null {
  const id = res.jobid ?? res.jobId;
  return typeof id === "string" && id !== "" ? id : null;
}

type SubmitGoogleFlowVideoArgs = {
  request: GoogleFlowVideosRequest;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  taskType: TaskType;
  meta: Record<string, unknown>;
};

/** Submit a Google Flow video generation as an async job and hand the local
 *  owner lease off to a pending task. `meta.googleFlow: true` is the
 *  discriminator sync.ts uses to route polling to the google-flow jobs
 *  endpoint (the engine's TaskType union has no google literals, so these
 *  tasks ride "seedance2_video" like veo3/gemini-omni do on kie). */
export async function submitGoogleFlowVideoTask(
  fs: VideocityFs,
  ctx: JobHandlerContext,
  args: SubmitGoogleFlowVideoArgs,
): Promise<string> {
  const provider = createGoogleFlowProvider();
  const request = withGoogleFlowCaptchaDefaults(args.request as Record<string, unknown>) as GoogleFlowVideosRequest;
  await fs.writeMetadata(args.assetId, "generation-payload", request, args.projectSlug);

  const res = await callGoogleFlowWithCaptchaRetry(
    (body) => provider.v1.videos({ ...(body as GoogleFlowVideosRequest), async: true }),
    request as Record<string, unknown>,
  );
  const taskId = readJobId(res as Record<string, unknown>);
  if (!taskId) throw new Error("Google Flow video submit returned no job id");

  const pendingResult = await fs.pendingTasks.write(args.projectSlug, {
    taskId,
    taskType: args.taskType,
    assetId: args.assetId,
    assetDir: args.assetDir,
    meta: { ...args.meta, googleFlow: true },
  }, ctx.getOwnerId());
  if (!pendingResult.ok) throw new Error(`Failed to write pending-task for ${args.assetId}: ${pendingResult.error.message}`);
  if (pendingResult.value === null) throw new Error(`Lost local lease while writing pending-task`);

  ctx.setLease({ kind: "task", taskId });
  return taskId;
}
