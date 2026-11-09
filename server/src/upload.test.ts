import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { probeVideo, runFfmpeg } from "./ffmpeg.js";
import { runGenerateMedia, type GenerateMediaJob } from "./jobs/generate-media.js";
import { configureProviderEndpoints } from "./media/endpoints.js";
import type { JobHandlerContext, LeaseToken } from "./queue.js";
import { testBudget } from "./test-budget.js";
import { contentHash, uploadBytesToFreeHost } from "./upload.js";
import { fitVideoUnderByteCap } from "./video-fit.js";

const UPLOAD_HOSTS = new Set(["litterbox.catbox.moe", "uguu.se", "tmpfile.link"]);
const FAL_STORAGE_HOST = "rest.fal.ai";
const LOCAL_HOSTS = new Set([...UPLOAD_HOSTS, FAL_STORAGE_HOST]);
const FAL_SOURCE_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const TASK_ID = "local-upscale-task";
const FAL_TASK_ID = "local-extend-task";

interface SourceVideo {
  bytes: Buffer;
  duration: number;
  width: number;
  height: number;
}

type GenerationRequest = Pick<GenerateMediaJob, "model" | "mode" | "options">;

const MACHGEN_REFERENCE: GenerationRequest = { model: "machgen:MiniMax-H3", mode: "r2v", options: { resolution: "768p", duration: 5 } };
const FAL_EXTEND: GenerationRequest = { model: "fal:minimax/h3-max/extend-video", options: { aspect_ratio: "16:9", duration: 5, resolution: "768P" } };

type Upload = { host: string; filename: string; contentType: string; bytes: Buffer };

async function requestBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe("free-host media uploads", () => {
  let fixtures: string;
  let video: Buffer;
  let root: string;
  let engine: Engine;
  let server: Server;
  let baseURL: string;
  let originalFetch: typeof fetch;
  let originalKey: string | undefined;
  let originalFalKey: string | undefined;
  let originalHarMode: string | undefined;
  let restoreEndpoints: () => void;
  let uploads: Upload[];
  let submissions: Record<string, unknown>[];
  let errors: unknown[];
  let delayMs: number;
  let hold: boolean;
  let failures: number;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await requestBytes(request);
    if (request.url === "/api/v0/generate") {
      submissions.push(JSON.parse(body.toString()) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ task_id: TASK_ID }));
      return;
    }
    if (request.url === "/minimax/h3-max/extend-video") {
      submissions.push(JSON.parse(body.toString()) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ request_id: FAL_TASK_ID, status: "IN_QUEUE" }));
      return;
    }
    if (request.url === `/${FAL_STORAGE_HOST}/storage/upload/initiate`) {
      const { file_name: filename } = JSON.parse(body.toString()) as { file_name: string };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ file_url: `${baseURL}/files/${filename}`, upload_url: `${baseURL}/fal-storage/${filename}` }));
      return;
    }
    if (request.method === "PUT" && request.url?.startsWith("/fal-storage/")) {
      uploads.push({ host: FAL_STORAGE_HOST, filename: request.url.slice("/fal-storage/".length), contentType: request.headers["content-type"] ?? "", bytes: body });
      response.end();
      return;
    }
    const form = await new Request(baseURL, {
      method: "POST", headers: { "content-type": request.headers["content-type"] ?? "" }, body: new Uint8Array(body),
    }).formData();
    const file = form.get("fileToUpload") ?? form.get("files[]") ?? form.get("file");
    if (!(file instanceof File)) throw new Error("Upload has no file");
    const host = request.url?.split("/")[1] ?? "";
    uploads.push({ host, filename: file.name, contentType: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    if (failures > 0) {
      failures -= 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Host temporarily unavailable" }));
      return;
    }
    if (hold) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      const url = `${baseURL}/files/source.mp4`;
      if (host === "litterbox.catbox.moe") response.end(url);
      else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(host === "uguu.se" ? { success: true, files: [{ url }] } : { downloadLink: url }));
      }
    }, uploads.length === 1 ? delayMs : 0);
    timers.add(timer);
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-upload-fixtures-"));
    const path = join(fixtures, "source.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=2", "-pix_fmt", "yuv420p", path]);
    video = await readFile(path);
  });

  afterAll(async () => { await rm(fixtures, { recursive: true, force: true }); });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-upload-"));
    engine = createEngine({ rootDir: join(root, "book"), initialBookName: "uploads", durableWrites: false });
    uploads = [];
    submissions = [];
    errors = [];
    delayMs = 0;
    hold = false;
    failures = 0;
    server = createServer((request, response) => {
      void serve(request, response).catch((error: unknown) => {
        errors.push(error);
        response.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");
    baseURL = `http://127.0.0.1:${address.port}`;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return LOCAL_HOSTS.has(url.hostname)
        ? originalFetch(`${baseURL}/${url.hostname}${url.pathname}`, init)
        : originalFetch(input, init);
    };
    originalKey = process.env.MACHGEN_API_KEY;
    originalFalKey = process.env.FAL_API_KEY;
    originalHarMode = process.env.VIDEOBOOK_HAR_CAPTURE;
    process.env.MACHGEN_API_KEY = "local-upload-key";
    process.env.FAL_API_KEY = "local-fal-key";
    process.env.VIDEOBOOK_HAR_CAPTURE = "off";
    restoreEndpoints = configureProviderEndpoints({ machgenBaseURL: baseURL, falQueueBaseURL: baseURL });
  });

  afterEach(async () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = originalFetch;
    restoreEndpoints();
    if (originalKey === undefined) delete process.env.MACHGEN_API_KEY;
    else process.env.MACHGEN_API_KEY = originalKey;
    if (originalFalKey === undefined) delete process.env.FAL_API_KEY;
    else process.env.FAL_API_KEY = originalFalKey;
    if (originalHarMode === undefined) delete process.env.VIDEOBOOK_HAR_CAPTURE;
    else process.env.VIDEOBOOK_HAR_CAPTURE = originalHarMode;
    engine.close();
    await rm(root, { recursive: true, force: true });
    expect(errors).toEqual([]);
  });

  async function generation(
    signal: AbortSignal,
    request: GenerationRequest = MACHGEN_REFERENCE,
    sourceVideo: SourceVideo = { bytes: video, duration: 2, width: 64, height: 64 },
  ): Promise<{ job: GenerateMediaJob; context: JobHandlerContext; sourceId: string }> {
    const source = await engine.artifacts.create("video", "source");
    const output = await engine.artifacts.create("video", "upscale");
    if (!source.ok || !output.ok) throw new Error("Could not create video artifacts");
    const sourceId = source.value.artifactId;
    const { bytes, ...original } = sourceVideo;
    expect((await engine.files.write(sourceId, "original.mp4", bytes)).ok).toBe(true);
    expect((await engine.metadata.artifacts.write(sourceId, "original", original)).ok).toBe(true);
    const assetId = output.value.artifactId;
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const lease = await engine.jobs.artifactWork.begin(assetId, { kind: "generate", ownerKind: "job", durationMs: testBudget(120_000) });
    if (!lease) throw new Error("Could not lease output");
    let token: LeaseToken = { kind: "owner", ownerId: lease.ownerId };
    return {
      sourceId,
      job: { type: "generate_media", bookId: engine.book.get().bookId,
        assetId, assetDir: manifest.value.path, prompt: "Continue the scene", refs: { video: [sourceId] }, ...request },
      context: {
        jobId: 1, signal,
        setLease: (next) => { token = next; },
        getOwnerId: () => {
          if (token.kind !== "owner") throw new Error("Lease already handed off");
          return token.ownerId;
        },
        markAssetFailureHandled: () => {},
      },
    };
  }

  it("submits a MachGen reference video after uploading beyond the former 30-second deadline", async () => {
    delayMs = testBudget(31_000);
    const { job, context, sourceId } = await generation(new AbortController().signal);
    await expect(runGenerateMedia(engine, job, context)).resolves.toMatchObject({ status: "pending", taskId: TASK_ID });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ filename: `${contentHash(video)}.mp4`, contentType: "video/mp4", bytes: video });
    expect(submissions).toEqual([expect.objectContaining({ model: "MiniMax-H3", task_type: "R2V", src_video_urls: [`${baseURL}/files/source.mp4`] })]);
    const source = await engine.files.read(sourceId, "original.mp4");
    expect(source.ok && Buffer.from(source.value)).toEqual(video);
    const task = engine.jobs.pending.read(job.assetId);
    expect(task.ok && task.value).toMatchObject({ taskId: TASK_ID, taskType: "machgen_media" });
  }, testBudget(70_000));

  it("re-encodes a source video over the model's byte cap before uploading it to Fal", async () => {
    const path = join(fixtures, "oversized.mp4");
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=gray:s=1280x720:r=30:d=1.2,noise=alls=100:allf=t+u",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
      "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
    ]);
    const oversized = await readFile(path);
    expect(oversized.byteLength).toBeGreaterThan(FAL_SOURCE_VIDEO_MAX_BYTES);
    const { job, context, sourceId } = await generation(new AbortController().signal, FAL_EXTEND, { bytes: oversized, duration: 1.2, width: 1280, height: 720 });
    await expect(runGenerateMedia(engine, job, context)).resolves.toMatchObject({ status: "pending", taskId: FAL_TASK_ID });
    expect(uploads).toHaveLength(1);
    const sent = uploads[0]!;
    expect(sent).toMatchObject({ host: FAL_STORAGE_HOST, filename: `${contentHash(sent.bytes)}.mp4`, contentType: "video/mp4" });
    expect(sent.bytes.byteLength).toBeLessThanOrEqual(FAL_SOURCE_VIDEO_MAX_BYTES);
    const sentPath = join(fixtures, "sent.mp4");
    await writeFile(sentPath, sent.bytes);
    const probe = await probeVideo(sentPath);
    expect(probe).toMatchObject({ width: 1280, height: 720, hasAudio: true, videoCodec: "h264" });
    expect(probe.duration).toBeCloseTo(1.2, 1);
    expect(submissions).toEqual([expect.objectContaining({ video_url: `${baseURL}/files/${sent.filename}`, prompt: "Continue the scene" })]);
    const source = await engine.files.read(sourceId, "original.mp4");
    expect(source.ok && Buffer.from(source.value).equals(oversized)).toBe(true);
    const task = engine.jobs.pending.read(job.assetId);
    expect(task.ok && task.value).toMatchObject({ taskId: FAL_TASK_ID, taskType: "fal_media" });
  });

  it("keeps a video within the cap byte-for-byte and explains when a clip is too long to fit", async () => {
    const within = await fitVideoUnderByteCap(video, "source.mp4", video.byteLength);
    expect(within.data).toBe(video);
    expect(within.filename).toBe("source.mp4");
    await expect(fitVideoUnderByteCap(video, "source.mp4", video.byteLength - 1))
      .rejects.toThrow(/2\.0 s long\. This model accepts source videos up to .* MB, and a clip this long cannot be re-encoded under that at usable quality\. Trim it and try again\./u);
  });

  it("rotates to another host after an HTTP failure without changing the video", async () => {
    failures = 1;
    await expect(uploadBytesToFreeHost(video, "source.mp4")).resolves.toBe(`${baseURL}/files/source.mp4`);
    expect(uploads).toHaveLength(2);
    expect(new Set(uploads.map((upload) => upload.host)).size).toBe(2);
    expect(uploads.every((upload) => upload.bytes.equals(video))).toBe(true);
  });

  it("reports upload deadlines instead of unexplained aborts for each host", async () => {
    hold = true;
    const timeoutMs = testBudget(500);
    const outcome = uploadBytesToFreeHost(video, "source.mp4", { timeoutMs });
    await expect(outcome).rejects.toThrow("All upload hosts failed");
    await expect(outcome).rejects.toThrow(`Upload timed out after ${timeoutMs / 1_000} seconds`);
    expect(new Set(uploads.map((upload) => upload.host))).toEqual(UPLOAD_HOSTS);
    await expect(outcome).rejects.not.toThrow("AbortError");
  });

  it("cancels a generation during upload without contacting other hosts or submitting to MachGen", async () => {
    hold = true;
    const controller = new AbortController();
    const { job, context } = await generation(controller.signal);
    const stopped = new Error("Generation cancelled");
    const outcome = runGenerateMedia(engine, job, context);
    const rejected = expect(outcome).rejects.toBe(stopped);
    await expect.poll(() => uploads.length, { timeout: testBudget(5_000) }).toBe(1);
    controller.abort(stopped);
    await rejected;
    expect(uploads).toHaveLength(1);
    expect(submissions).toEqual([]);
    const task = engine.jobs.pending.read(job.assetId);
    expect(task.ok && task.value).toBeNull();
  });

  it("refuses an already cancelled upload before sending any bytes", async () => {
    const stopped = new Error("Already cancelled");
    await expect(uploadBytesToFreeHost(video, "source.mp4", { signal: AbortSignal.abort(stopped) })).rejects.toBe(stopped);
    expect(uploads).toEqual([]);
  });
});
