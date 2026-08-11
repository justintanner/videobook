import { readFile } from "node:fs/promises";
import { AceStepError } from "./errors.js";

export interface SynthCoverRequest {
  caption: string;
  lyrics: string;
  taskType: "cover" | "cover-nofsq";
  outputFormat: "wav16";
  seed: number;
  inferenceSteps: number;
  audioCoverStrength: number;
  synthBatchSize: 1;
  synthModel: string;
  duration: number;
}

export interface SynthCoverResult {
  audio: Buffer;
  audioContentType: string;
  latents: Buffer | null;
}

export interface MultipartPart {
  headers: Record<string, string>;
  data: Buffer;
}

export interface SynthCoverOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

// The live ace-server job flow (tools/ace-server.cpp, verified against version
// 9761469): POST /synth returns {"id"} immediately, a FIFO worker thread runs
// the GPU job, GET /job?id reports running|done|failed|cancelled, GET
// /job?id&result=1 serves the multipart/mixed body (fixed boundary
// "ace-batch-boundary": one audio part plus one latent part per track), and
// POST /job?id&cancel=1 cancels a running job. Completed jobs are evicted FIFO
// past 32, so the result is fetched immediately after the poll reports done.
const DEFAULT_SYNTH_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 5_000;
const RESULT_TIMEOUT_MS = 120_000;
const ERROR_BODY_PREVIEW_CHARS = 500;

export async function isHealthy(baseUrl: string, timeoutMs = 500): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function wireRequest(request: SynthCoverRequest): Record<string, unknown> {
  return {
    caption: request.caption,
    lyrics: request.lyrics,
    task_type: request.taskType,
    output_format: request.outputFormat,
    seed: request.seed,
    inference_steps: request.inferenceSteps,
    audio_cover_strength: request.audioCoverStrength,
    synth_batch_size: request.synthBatchSize,
    synth_model: request.synthModel,
    duration: request.duration,
  };
}

function headerRecord(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

export function parseMultipartMixed(body: Buffer, contentType: string): MultipartPart[] {
  const boundaryMatch = /boundary="?([^";]+)"?/u.exec(contentType);
  if (boundaryMatch === null) {
    throw new AceStepError(
      "malformed_response",
      `ace-server response has no multipart boundary (content-type: "${contentType}")`,
    );
  }
  const delimiter = Buffer.from(`--${boundaryMatch[1]}`);
  const parts: MultipartPart[] = [];
  let offset = body.indexOf(delimiter);
  while (offset !== -1) {
    const afterDelimiter = offset + delimiter.length;
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString("latin1") === "--") break;
    const boundaryLineEnd = body.indexOf("\r\n", afterDelimiter);
    const headerEnd = body.indexOf("\r\n\r\n", afterDelimiter);
    const next = headerEnd === -1 ? -1 : body.indexOf(delimiter, headerEnd + 4);
    if (boundaryLineEnd === -1 || headerEnd === -1 || next === -1) {
      throw new AceStepError("malformed_response", "ace-server multipart response is truncated");
    }
    const headerBlock = body.subarray(boundaryLineEnd + 2, headerEnd).toString("utf8");
    let dataEnd = next;
    if (body.subarray(dataEnd - 2, dataEnd).toString("latin1") === "\r\n") dataEnd -= 2;
    parts.push({ headers: headerRecord(headerBlock), data: body.subarray(headerEnd + 4, dataEnd) });
    offset = next;
  }
  if (parts.length === 0) {
    throw new AceStepError("malformed_response", "ace-server multipart response contained no parts");
  }
  return parts;
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

async function readErrorPreview(response: Response): Promise<string> {
  const bodyText = await response.text().catch(() => "");
  return bodyText.slice(0, ERROR_BODY_PREVIEW_CHARS);
}

async function submitSynthJob(
  baseUrl: string,
  srcWavPath: string,
  request: SynthCoverRequest,
  signal: AbortSignal,
): Promise<string> {
  const sourceBytes = await readFile(srcWavPath);
  const form = new FormData();
  form.set(
    "request",
    new Blob([JSON.stringify(wireRequest(request))], { type: "application/json" }),
    "request.json",
  );
  form.set("audio", new Blob([sourceBytes], { type: "audio/wav" }), "source.wav");
  const response = await fetch(`${baseUrl}/synth`, { method: "POST", body: form, signal });
  if (!response.ok) {
    throw new AceStepError(
      "synth_http_error",
      `ace-server /synth returned ${response.status}: ${await readErrorPreview(response)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string" || body.id.length === 0) {
    throw new AceStepError("malformed_response", "ace-server /synth returned no job id");
  }
  return body.id;
}

async function readJobStatus(baseUrl: string, jobId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/job?id=${encodeURIComponent(jobId)}`, {
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new AceStepError(
      "synth_http_error",
      `ace-server /job returned ${response.status}: ${await readErrorPreview(response)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
  if (typeof body?.status !== "string") {
    throw new AceStepError("malformed_response", "ace-server /job returned no status");
  }
  return body.status;
}

async function cancelSynthJob(baseUrl: string, jobId: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/job?id=${encodeURIComponent(jobId)}&cancel=1`, {
      method: "POST",
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
  } catch {
    // Best-effort: the job also dies with the server, and an orphaned
    // generation is discarded when its result is never fetched.
  }
}

async function fetchSynthResult(baseUrl: string, jobId: string): Promise<SynthCoverResult> {
  const response = await fetch(`${baseUrl}/job?id=${encodeURIComponent(jobId)}&result=1`, {
    signal: AbortSignal.timeout(RESULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new AceStepError(
      "synth_http_error",
      `ace-server /job result returned ${response.status}: ${await readErrorPreview(response)}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  const body = Buffer.from(await response.arrayBuffer());
  if (contentType.startsWith("audio/")) {
    return { audio: body, audioContentType: contentType, latents: null };
  }
  const parts = parseMultipartMixed(body, contentType);
  const audioPart = parts.find((part) => (part.headers["content-type"] ?? "").startsWith("audio/"));
  if (audioPart === undefined) {
    throw new AceStepError("malformed_response", "ace-server synth result contained no audio part");
  }
  const latentPart = parts.find((part) =>
    (part.headers["content-type"] ?? "").startsWith("application/octet-stream"),
  );
  return {
    audio: audioPart.data,
    audioContentType: audioPart.headers["content-type"] ?? "audio/wav",
    latents: latentPart?.data ?? null,
  };
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function synthCover(
  baseUrl: string,
  srcWavPath: string,
  request: SynthCoverRequest,
  options: SynthCoverOptions = {},
): Promise<SynthCoverResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SYNTH_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineSignal])
    : deadlineSignal;

  let jobId: string | null = null;
  try {
    jobId = await submitSynthJob(baseUrl, srcWavPath, request, AbortSignal.any([signal, AbortSignal.timeout(SUBMIT_TIMEOUT_MS)]));
    for (;;) {
      const status = await readJobStatus(baseUrl, jobId);
      if (status === "done") return await fetchSynthResult(baseUrl, jobId);
      if (status === "failed") {
        throw new AceStepError(
          "synth_failed",
          "ace-server reported the cover synthesis job as failed; the reason is in the [ace-step] logs above",
        );
      }
      if (status === "cancelled") {
        throw new AceStepError("synth_failed", "ace-server cancelled the cover synthesis job");
      }
      signal.throwIfAborted();
      await delay(pollIntervalMs, signal);
    }
  } catch (error) {
    if (error instanceof AceStepError) throw error;
    if (jobId !== null && signal.aborted) await cancelSynthJob(baseUrl, jobId);
    if (options.signal?.aborted) throw error;
    if (deadlineSignal.aborted) {
      throw new AceStepError(
        "synth_timeout",
        `ace-server cover synthesis did not finish within ${timeoutMs}ms`,
      );
    }
    throw new AceStepError(
      "server_exited",
      `ace-server request failed: ${describeFetchError(error)}. The server may have crashed or been stopped; check [ace-step] logs.`,
    );
  }
}
