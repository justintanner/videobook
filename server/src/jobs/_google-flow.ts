import { createGoogle } from "@apicity/google";
import type { GoogleFlowVideosRequest, GoogleProvider } from "@apicity/google";
import type { TaskType, VideocityFs } from "videocity-engine";
import type { JobHandlerContext } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { prepareAssetForUpload, prepareBytesForUpload } from "../upload.js";

export const GOOGLE_FLOW_ENV_KEY = "GOOGLE_FLOW_API_KEY";

// The synchronous google-flow endpoints (images) block until Google Flow
// finishes rendering — useapi.net polls up to 10 minutes server-side before
// returning 408 — so the client timeout must comfortably cover that window.
const GOOGLE_FLOW_TIMEOUT_MS = 10 * 60_000;

// @apicity/google reads `apiKey` for the Vertex express-mode host and
// `flowApiKey` for the useapi.net Google Flow host (falling back to `apiKey`).
// Only the flow endpoints are wired here, so the single useapi.net token
// serves both options.
export function createGoogleFlowProvider(timeoutMs: number = GOOGLE_FLOW_TIMEOUT_MS): GoogleProvider {
  const apiKey = requireApiKey(GOOGLE_FLOW_ENV_KEY);
  return createGoogle({ apiKey, flowApiKey: apiKey, timeout: timeoutMs });
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
  provider: GoogleProvider,
  data: Uint8Array,
  contentType: string,
  label: string,
): Promise<string> {
  const body = new Blob([new Uint8Array(data)], { type: contentType });
  const res = await provider.v1.googleFlow.assets({ body, contentType });
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
  provider: GoogleProvider,
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
export async function uploadUrlToGoogleFlow(provider: GoogleProvider, url: string): Promise<string> {
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
  await fs.writeMetadata(args.assetId, "generation-payload", args.request, args.projectSlug);

  const res = await provider.v1.googleFlow.videos({ ...args.request, async: true });
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
