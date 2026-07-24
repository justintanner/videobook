import { createGoogleFlow, GoogleFlowError } from "@apicity/googleflow";
import type { GoogleFlowVideosRequest, GoogleFlowProvider } from "@apicity/googleflow";
import type { TaskType, Engine } from "videobook-engine";
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

// @apicity/googleflow@0.8.0 restores `:` and `@` via encodePathSegment.
// Keep this defensive decode for older package builds and any residual
// over-encoding; it is a no-op when the path is already raw.
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

export type GoogleFlowFailureDetail = { code: string; reasons: string[] };

/** Collect structured failure details from a Google Flow job body.
 *
 *  Collection order (dedup by code; tolerant `Record<string, unknown>` walks):
 *    ① `response.operations[].operation.error.message` — generic operation
 *       failures (code only, no reasons).
 *    ② `response.media[].mediaMetadata.mediaStatus` — omni-flash media failures
 *       live here: `error.message` → code, `failureReasons[]` → reasons
 *       (reason === code excluded; only entries whose `mediaGenerationStatus`
 *       is absent or `MEDIA_GENERATION_STATUS_FAILED`).
 *    ③ fallback (only when ①/② yield nothing): `response.error.details[].reason`
 *       then `response.error.message` — content-policy rejections. */
export function extractGoogleFlowFailureDetails(job: Record<string, unknown>): GoogleFlowFailureDetail[] {
  const response = job.response;
  if (!response || typeof response !== "object") return [];
  const res = response as Record<string, unknown>;

  const details: GoogleFlowFailureDetail[] = [];
  const seen = new Set<string>();
  const push = (code: string, rawReasons: unknown[]): void => {
    const c = code.trim();
    if (c === "" || seen.has(c)) return;
    seen.add(c);
    const reasons = rawReasons
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.trim())
      .filter((r) => r !== "" && r !== c);
    details.push({ code: c, reasons });
  };

  const operations = res.operations;
  if (Array.isArray(operations)) {
    for (const entry of operations) {
      if (!entry || typeof entry !== "object") continue;
      const operation = (entry as Record<string, unknown>).operation;
      if (!operation || typeof operation !== "object") continue;
      const err = (operation as Record<string, unknown>).error;
      if (!err || typeof err !== "object") continue;
      const message = (err as Record<string, unknown>).message;
      if (typeof message === "string") push(message, []);
    }
  }

  const media = res.media;
  if (Array.isArray(media)) {
    for (const entry of media) {
      if (!entry || typeof entry !== "object") continue;
      const metadata = (entry as Record<string, unknown>).mediaMetadata;
      if (!metadata || typeof metadata !== "object") continue;
      const mdRec = metadata as Record<string, unknown>;
      const genStatus = mdRec.mediaGenerationStatus;
      if (typeof genStatus === "string" && genStatus !== "MEDIA_GENERATION_STATUS_FAILED") continue;
      const status = mdRec.mediaStatus;
      if (!status || typeof status !== "object") continue;
      const sRec = status as Record<string, unknown>;
      const errorObj = sRec.error;
      if (!errorObj || typeof errorObj !== "object") continue;
      const message = (errorObj as Record<string, unknown>).message;
      if (typeof message === "string") push(message, Array.isArray(sRec.failureReasons) ? sRec.failureReasons : []);
    }
  }

  if (details.length > 0) return details;

  const nested = res.error;
  if (nested && typeof nested === "object") {
    const nRec = nested as Record<string, unknown>;
    const d = nRec.details;
    if (Array.isArray(d)) {
      for (const item of d) {
        if (!item || typeof item !== "object") continue;
        const reason = (item as Record<string, unknown>).reason;
        if (typeof reason === "string") push(reason, []);
      }
    }
    if (details.length === 0) {
      const message = nRec.message;
      if (typeof message === "string") push(message, []);
    }
  }

  return details;
}

const GOOGLE_FLOW_GUIDANCE: { match: string; guidance: string }[] = [
  {
    match: "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED",
    guidance: "Google blocked this: the character/reference photos appear to contain an identifiable real person. Use stylized or AI-generated character images, remove the character refs, or try a different provider.",
  },
  {
    match: "IDENTIFIABLE_PERSON_SAFETY",
    guidance: "Google blocked this: the character/reference photos appear to contain an identifiable real person. Use stylized or AI-generated character images, remove the character refs, or try a different provider.",
  },
  {
    match: "PUBLIC_ERROR_MINOR",
    guidance: "Google blocked this: the inputs or output appear to depict a minor. Remove images of children or reword the prompt.",
  },
  {
    match: "PUBLIC_ERROR_UNSAFE_GENERATION",
    guidance: "Google's safety filter rejected the generated content. Reword the prompt or swap the reference images.",
  },
  {
    match: "PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC",
    guidance: "Google rate-limited this request. Wait a minute and retry.",
  },
  // Omni Flash V2V (abra_edit) often dies with this opaque mediaStatus and no
  // PUBLIC_ERROR_* reason — request was accepted; Google's edit job failed.
  {
    match: "Generation job finished with state: FAILED",
    guidance: "Google's video editor failed without a policy reason (common on Omni V2V). Retry once, describe the edit more specifically, or try a different source clip / aspect.",
  },
];

function findGoogleFlowGuidance(details: GoogleFlowFailureDetail[]): string | undefined {
  for (const d of details) {
    const tokens = [d.code, ...d.reasons];
    for (const token of tokens) {
      for (const entry of GOOGLE_FLOW_GUIDANCE) {
        if (token === entry.match) return entry.guidance;
      }
    }
  }
  return undefined;
}

function renderFailureDetails(details: GoogleFlowFailureDetail[]): string {
  return details
    .map((d) => (d.reasons.length > 0 ? `${d.code} (${d.reasons.join(", ")})` : d.code))
    .join("; ");
}

/** Prefer the top-level job.error string, then append nested operation /
 *  policy reasons (e.g. PUBLIC_ERROR_MINOR) so cards show more than
 *  "All operations failed". Renders each detail as `CODE (REASON1, REASON2)`. */
export function formatGoogleFlowJobError(job: Record<string, unknown>): string {
  const base = typeof job.error === "string" && job.error.trim() !== ""
    ? job.error.trim()
    : "Google Flow job failed";
  const details = extractGoogleFlowFailureDetails(job);
  if (details.length === 0) return base;
  const detail = renderFailureDetails(details);
  if (base.includes(detail)) return base;
  return `${base}: ${detail}`;
}

/** Technical error string + plain-English guidance suffix for the first matching
 *  code/reason. `failCode` is the first detail's code (for generation_errors).
 *  Unmapped codes degrade to the technical string with no suffix. */
export function describeGoogleFlowJobFailure(job: Record<string, unknown>): { message: string; failCode?: string } {
  const technical = formatGoogleFlowJobError(job);
  const details = extractGoogleFlowFailureDetails(job);
  const guidance = findGoogleFlowGuidance(details);
  const message = guidance ? `${technical} — ${guidance}` : technical;
  const failCode = details.length > 0 ? details[0].code : undefined;
  return { message, ...(failCode !== undefined ? { failCode } : {}) };
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
  fs: Engine,
  assetId: string,
  filename: string,
  bookId: string,
): Promise<string> {
  const { data, contentType } = await prepareAssetForUpload(fs, assetId, filename, bookId);
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
  bookId: string;
  taskType: TaskType;
  meta: Record<string, unknown>;
};

/** Submit a Google Flow video generation as an async job and hand the local
 *  owner lease off to a pending task. `meta.googleFlow: true` is the
 *  discriminator sync.ts uses to route polling to the google-flow jobs
 *  endpoint (the engine's TaskType union has no google literals, so these
 *  tasks ride "seedance2_video" like veo3/gemini-omni do on kie). */
export async function submitGoogleFlowVideoTask(
  fs: Engine,
  ctx: JobHandlerContext,
  args: SubmitGoogleFlowVideoArgs,
): Promise<string> {
  const provider = createGoogleFlowProvider();
  const request = withGoogleFlowCaptchaDefaults(args.request as Record<string, unknown>) as GoogleFlowVideosRequest;
  await fs.metadata.artifacts.write(args.assetId, "generation-payload", request);

  let res: Record<string, unknown>;
  try {
    res = (await callGoogleFlowWithCaptchaRetry(
      (body) => provider.v1.videos({ ...(body as GoogleFlowVideosRequest), async: true }),
      request as Record<string, unknown>,
    )) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof GoogleFlowError) {
      if (e.message.match(/^Google API error (\d+): API error: \d+$/)) {
        e.message = `${e.message} — request rejected by Google Flow — check reference/character inputs (see payload for asset ${args.assetId})`;
      } else if (e.body && typeof e.body === "object") {
        try {
          const b = { ...(e.body as Record<string, unknown>) };
          if (b.error && typeof b.error === "string" && e.message.includes(b.error)) delete b.error;
          const bodyStr = JSON.stringify(b);
          if (bodyStr !== "{}" && bodyStr !== '{"error":{}}') {
            e.message = `${e.message} ${bodyStr}`;
          }
        } catch {
          // ignore serialization errors
        }
      }
    }
    throw e;
  }

  const taskId = readJobId(res);
  if (!taskId) throw new Error("Google Flow video submit returned no job id");

  const pendingResult = await fs.jobs.pending.write({
    taskId,
    taskType: args.taskType,
    artifactId: args.assetId,
    meta: { ...args.meta, googleFlow: true },
  }, ctx.getOwnerId());
  if (!pendingResult.ok) throw new Error(`Failed to write pending-task for ${args.assetId}: ${pendingResult.error.message}`);
  if (pendingResult.value === null) throw new Error(`Lost local lease while writing pending-task`);

  ctx.setLease({ kind: "task", taskId });
  return taskId;
}
