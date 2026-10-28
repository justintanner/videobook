import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { YtDlp } from "ytdlp-nodejs";
import {
  DOWNLOAD_FAILURE_METADATA_KEY,
  applyRequestedDownloadRange,
  classifyDownloadFailure,
  configureDownloadClockForTests,
  downloadVideoFile,
  fetchVideoInfo,
  isImageContent,
  imageExtension,
  isTikTokUrl,
  openYtdlpSession,
} from "./download-video.js";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { queue, registerJobHandler, waitForJob } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { materializeVideoFixture } from "../test-media-fixtures.js";
import { ytdlpRunOptions } from "../ytdlp-binary.js";

type FakeStep = "probe" | "info" | "download";

interface FakeYtdlpCall {
  step: FakeStep;
  args: string[];
  cookies: string | null;
}

interface FakeYtdlpConfig {
  targets?: string;
  error?: string;
  failures?: Partial<Record<FakeStep, number>>;
}

const TIKTOK_URL = "https://www.tiktok.com/@creator/video/7430000000000000001";
const OTHER_URL = "http://127.0.0.1:9/video/1";
const FORBIDDEN = "[TikTok] 7430000000000000001: Unable to download webpage: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)";
const IMPERSONATE_TARGETS = [
  "[info] Available impersonate targets",
  "Client          OS           Source",
  "--------------------------------------",
  "Firefox         -            curl_cffi>=0.10 (unavailable)",
  "Chrome-136      Macos-15     curl_cffi",
  "Safari-18.0     Ios-18.0     curl_cffi",
  "",
].join("\n");

const FAKE_YTDLP_SCRIPT = [
  `#!${process.execPath}`,
  "const fs = require(\"node:fs\");",
  "const path = require(\"node:path\");",
  "const config = JSON.parse(fs.readFileSync(path.join(__dirname, \"config.json\"), \"utf8\"));",
  "const args = process.argv.slice(2);",
  "const step = args.includes(\"--list-impersonate-targets\") ? \"probe\" : args.includes(\"--dump-single-json\") ? \"info\" : \"download\";",
  "const cookiesAt = args.indexOf(\"--cookies\");",
  "const cookies = cookiesAt < 0 ? null : fs.readFileSync(args[cookiesAt + 1], \"utf8\");",
  "fs.appendFileSync(path.join(__dirname, \"calls.jsonl\"), JSON.stringify({ step, args, cookies }) + \"\\n\");",
  "if (step === \"probe\") { process.stdout.write(config.targets); process.exit(0); }",
  "if (cookies !== null) fs.appendFileSync(args[cookiesAt + 1], \"# rewritten by yt-dlp\\n\");",
  "const counter = path.join(__dirname, step + \".count\");",
  "const count = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, \"utf8\")) : 0) + 1;",
  "fs.writeFileSync(counter, String(count));",
  "if (count <= (config.failures[step] ?? 0)) { process.stderr.write(\"ERROR: \" + config.error + \"\\n\"); process.exit(1); }",
  "if (step === \"info\") { process.stdout.write(JSON.stringify(config.info) + \"\\n\"); process.exit(0); }",
  "fs.copyFileSync(config.fixture, args[args.indexOf(\"-o\") + 1]);",
  "",
].join("\n");

async function writeFakeYtdlp(directory: string, config: FakeYtdlpConfig = {}): Promise<string> {
  const fixture = await materializeVideoFixture({ width: 64, height: 64, durationSec: 1, fps: 10, source: "color", audio: false });
  await writeFile(join(directory, "config.json"), JSON.stringify({
    targets: config.targets ?? IMPERSONATE_TARGETS,
    error: config.error ?? FORBIDDEN,
    failures: config.failures ?? {},
    info: { title: "Rank one", uploader: "creator", extractor: "TikTok", ext: "mp4", vcodec: "h264", duration: 1 },
    fixture,
  }));
  const path = join(directory, "yt-dlp");
  await writeFile(path, FAKE_YTDLP_SCRIPT);
  await chmod(path, 0o755);
  return path;
}

async function fakeCalls(directory: string, step?: FakeStep): Promise<FakeYtdlpCall[]> {
  const log = await readFile(join(directory, "calls.jsonl"), "utf8").catch(() => "");
  const calls = log.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeYtdlpCall);
  return step ? calls.filter((call) => call.step === step) : calls;
}

function withoutTikTokArgs(args: readonly string[]): string[] {
  return args.filter((arg, index) =>
    !["--impersonate", "--cookies"].includes(arg) && !["--impersonate", "--cookies"].includes(args[index - 1] ?? ""));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("applyRequestedDownloadRange", () => {
  it("persists an exact first-30-seconds original", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "videobook-download-range-"));
    const engineRoot = join(tempDir, "engine");
    const engine = createEngineForTest(engineRoot);
    try {
      const artifact = await engine.artifacts.create("vid", "range-source");
      if (!artifact.ok) throw new Error(artifact.error.message);
      const sourcePath = join(tempDir, "source.mp4");
      await runFfmpeg([
        "-y",
        "-f", "lavfi", "-i", "color=c=black:s=16x16:d=32:r=10",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-movflags", "+faststart",
        sourcePath,
      ]);
      const written = await engine.files.writeFromPath(
        artifact.value.artifactId,
        "original.mp4",
        sourcePath,
      );
      if (!written.ok) throw new Error(written.error.message);

      const applied = await applyRequestedDownloadRange(
        engine,
        artifact.value.artifactId,
        artifact.value.path,
        written.value,
        { start: 0, end: 30 },
      );

      const media = await probeVideo(written.value);
      expect(applied).toBe(true);
      expect(media.duration).toBeGreaterThanOrEqual(29.9);
      expect(media.duration).toBeLessThanOrEqual(30.05);
    } finally {
      closeEngineForTest(engineRoot, engine);
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("download-video job handler", () => {
  it("exports registerDownloadVideoJob function", async () => {
    const mod = await import("./download-video.js");
    expect(typeof mod.registerDownloadVideoJob).toBe("function");
  });

  it("registerDownloadVideoJob accepts a fs argument", async () => {
    const mod = await import("./download-video.js");
    expect(mod.registerDownloadVideoJob.length).toBe(1);
  });
});

describe("validateDownloadOutput (RC1)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-dl-validate-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function writeValidMp4(path: string): Promise<void> {
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.1:r=10",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast",
      "-movflags", "+faststart",
      path,
    ]);
  }

  it("succeeds when output file exists and contains a valid mp4", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const outputPath = join(tempDir, "original.mp4");
    await writeValidMp4(outputPath);

    // Should not throw
    await validateDownloadOutput(outputPath);
  });

  it("throws when the file is non-empty but not a decodable container", async () => {
    // Regression: yt-dlp can finalize a non-empty mp4 missing its moov atom
    // when --download-sections is interrupted. The size check passed but
    // process_video would then fail mid-pipeline and strand the asset.
    const { validateDownloadOutput } = await import("./download-video.js");
    const { access } = await import("node:fs/promises");
    const outputPath = join(tempDir, "original.mp4");
    await writeFile(outputPath, "fake-video-content-no-moov-atom");

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow(/unreadable video/i);
    // Broken file is removed so a retry doesn't trip on stale bytes.
    await expect(access(outputPath)).rejects.toThrow();
  });

  it("throws when output file is missing and .part file exists", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const outputPath = join(tempDir, "original.mp4");
    // Only .part file exists (simulating failed download)
    await writeFile(outputPath + ".part", "");

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow(/download incomplete/i);
  });

  it("removes the .part file when cleaning up failed download", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const { access } = await import("node:fs/promises");
    const outputPath = join(tempDir, "original.mp4");
    await writeFile(outputPath + ".part", "");

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow();

    // .part file should be cleaned up
    await expect(access(outputPath + ".part")).rejects.toThrow();
  });

  it("throws when output file is missing and no .part file exists", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const outputPath = join(tempDir, "original.mp4");
    // Nothing exists

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow(/download failed/i);
  });

  it("throws when output file exists but is 0 bytes", async () => {
    const { validateDownloadOutput } = await import("./download-video.js");
    const outputPath = join(tempDir, "original.mp4");
    await writeFile(outputPath, ""); // 0 bytes

    await expect(validateDownloadOutput(outputPath)).rejects.toThrow(/empty/i);
  });
});

describe("isImageContent", () => {
  it("returns true for jpg with no video codec", () => {
    expect(isImageContent({ ext: "jpg", vcodec: "none" })).toBe(true);
  });

  it("returns true for png with no vcodec field", () => {
    expect(isImageContent({ ext: "png" })).toBe(true);
  });

  it("returns true for webp with vcodec none", () => {
    expect(isImageContent({ ext: "webp", vcodec: "none" })).toBe(true);
  });

  it("returns false for mp4 with h264 codec", () => {
    expect(isImageContent({ ext: "mp4", vcodec: "h264" })).toBe(false);
  });

  it("returns false when ext is mp4 even without vcodec", () => {
    expect(isImageContent({ ext: "mp4" })).toBe(false);
  });

  it("returns false when no ext is set", () => {
    expect(isImageContent({})).toBe(false);
  });

  it("returns false for image ext with a real video codec", () => {
    expect(isImageContent({ ext: "jpg", vcodec: "h264" })).toBe(false);
  });

  it("handles case-insensitive extensions", () => {
    expect(isImageContent({ ext: "JPG", vcodec: "none" })).toBe(true);
    expect(isImageContent({ ext: "PNG" })).toBe(true);
  });
});

describe("imageExtension", () => {
  it("returns .jpg for jpg ext", () => {
    expect(imageExtension({ ext: "jpg" })).toBe(".jpg");
  });

  it("returns .png for png ext", () => {
    expect(imageExtension({ ext: "png" })).toBe(".png");
  });

  it("returns .webp for webp ext", () => {
    expect(imageExtension({ ext: "webp" })).toBe(".webp");
  });

  it("defaults to .jpg when ext is missing", () => {
    expect(imageExtension({})).toBe(".jpg");
  });

  it("defaults to .jpg for non-image ext", () => {
    expect(imageExtension({ ext: "mp4" })).toBe(".jpg");
  });
});

describe("download failure reasons", () => {
  it("retries only blocks, rate limits, server errors and network failures", () => {
    const messages = [
      "yt-dlp exited with code 1: 7430000000000000001: Unable to download webpage: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)",
      "yt-dlp exited with code 1: 7430000000000000001: Unable to download webpage: HTTP Error 429: Too Many Requests",
      "yt-dlp exited with code 1: 7430000000000000001: Unable to download webpage: HTTP Error 503: Service Unavailable",
      "yt-dlp exited with code 1: 7430000000000000001: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>",
      "yt-dlp exited with code 1: unable to download video data: Failed to perform, curl: (28) Operation timed out after 20001 milliseconds",
      "yt-dlp exited with code 1: 7430000000000000001: Video not available, status code 10231",
      "yt-dlp exited with code 1: 7430000000000000001: You do not have permission to view this post. Log into an account that has access",
      "yt-dlp exited with code 1: dQw4w9WgXcQ: Video unavailable. This video has been removed by the uploader",
      "yt-dlp exited with code 1: 7430000000000000001: Your IP address is blocked from accessing this post",
      "yt-dlp exited with code 1: dQw4w9WgXcQ: The uploader has not made this video available in your country",
      "yt-dlp exited with code 1: 7430000000000000001: TikTok is requiring login for access to this content",
      "Download produced an empty file",
    ];
    expect(messages.map((message) => {
      const failure = classifyDownloadFailure(message);
      return [failure.class, failure.transient];
    })).toEqual([
      ["forbidden", true],
      ["rate-limited", true],
      ["server-error", true],
      ["network", true],
      ["network", true],
      ["unavailable", false],
      ["private", false],
      ["removed", false],
      ["geo-blocked", false],
      ["geo-blocked", false],
      ["login-required", false],
      ["error", false],
    ]);
  });

  it("keeps the class and the tail of yt-dlp's message", () => {
    expect(classifyDownloadFailure(
      "Failed to fetch video info: yt-dlp exited with code 1: 7430000000000000001: Unable to extract universal data for rehydration; "
      + "please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. "
      + "Confirm you are on the latest version using  yt-dlp -U",
    ).reason).toBe("error: 7430000000000000001: Unable to extract universal data for rehydration");

    const long = classifyDownloadFailure(`yt-dlp exited with code 1: ${"x".repeat(500)} HTTP Error 429: Too Many Requests`);
    expect(long.reason).toMatch(/^rate-limited: …x+ HTTP Error 429: Too Many Requests$/u);
    expect(long.reason).toHaveLength("rate-limited: ".length + 240);
  });

  it("recognises TikTok hosts only", () => {
    expect([
      TIKTOK_URL,
      "https://vm.tiktok.com/ZMabc123/",
      "https://tiktok.com/@creator",
      "https://example.com/www.tiktok.com/video/1",
      "https://nottiktok.com/@creator/video/1",
      "not a url",
    ].map(isTikTokUrl)).toEqual([true, true, true, false, false, false]);
  });
});

describe("TikTok yt-dlp session", () => {
  const previousPath = process.env.VIDEOBOOK_YTDLP_PATH;
  const previousCookies = process.env.VIDEOBOOK_YTDLP_COOKIES;
  let dir: string;
  let fake: string;
  let sleeps: number[];
  let clock: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "videobook-ytdlp-session-"));
    sleeps = [];
    clock = 1_000_000;
    configureDownloadClockForTests({
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    delete process.env.VIDEOBOOK_YTDLP_COOKIES;
  });

  afterEach(async () => {
    configureDownloadClockForTests(null);
    restoreEnv("VIDEOBOOK_YTDLP_PATH", previousPath);
    restoreEnv("VIDEOBOOK_YTDLP_COOKIES", previousCookies);
    await rm(dir, { recursive: true, force: true });
  });

  async function useFake(config?: FakeYtdlpConfig): Promise<YtDlp> {
    fake = await writeFakeYtdlp(dir, config);
    process.env.VIDEOBOOK_YTDLP_PATH = fake;
    return new YtDlp(ytdlpRunOptions());
  }

  function open(url: string, bookId: string = randomUUID()) {
    return openYtdlpSession({ url, bookId, binaryPath: fake });
  }

  it("impersonates chrome and hands yt-dlp a private cookies copy for TikTok only", async () => {
    const ytdlp = await useFake();
    const cookies = join(dir, "cookies.txt");
    const jar = "# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tsecret-session\n";
    await writeFile(cookies, jar);
    process.env.VIDEOBOOK_YTDLP_COOKIES = cookies;
    const output = join(dir, "original.mp4");

    const tiktok = await open(TIKTOK_URL);
    const copy = tiktok.args[3] ?? "";
    expect(tiktok.args).toEqual(["--impersonate", "chrome", "--cookies", copy]);
    expect(copy).not.toBe(cookies);
    expect(await fetchVideoInfo(ytdlp, TIKTOK_URL, tiktok)).toMatchObject({ title: "Rank one" });
    await downloadVideoFile(ytdlp, TIKTOK_URL, output, undefined, tiktok);
    await tiktok.close();

    const other = await open(OTHER_URL);
    expect(other.args).toEqual([]);
    await fetchVideoInfo(ytdlp, OTHER_URL, other);
    await downloadVideoFile(ytdlp, OTHER_URL, output, undefined, other);
    await other.close();

    const calls = await fakeCalls(dir);
    expect(calls.map((call) => call.step)).toEqual(["probe", "info", "download", "info", "download"]);
    const [, tiktokInfo, tiktokDownload, otherInfo, otherDownload] = calls;
    expect(tiktokInfo?.args.slice(-6)).toEqual(["--impersonate", "chrome", "--cookies", copy, "--", TIKTOK_URL]);
    expect(tiktokDownload?.args.slice(-9)).toEqual([
      "--merge-output-format", "mp4", "--no-playlist", "--impersonate", "chrome", "--cookies", copy, "--", TIKTOK_URL,
    ]);
    expect(otherInfo?.args.slice(0, 4)).toEqual(["--flat-playlist", "--js-runtime", "node", "--dump-single-json"]);
    expect(otherInfo?.args.slice(-4)).toEqual(["--progress", "--newline", "--", OTHER_URL]);
    expect(otherDownload?.args.slice(-7)).toEqual(["--progress", "--newline", "--merge-output-format", "mp4", "--no-playlist", "--", OTHER_URL]);
    const asOther = (args: readonly string[]) => withoutTikTokArgs(args).map((arg) => arg === TIKTOK_URL ? OTHER_URL : arg);
    expect(asOther(tiktokInfo?.args ?? [])).toEqual(otherInfo?.args);
    expect(asOther(tiktokDownload?.args ?? [])).toEqual(otherDownload?.args);

    expect(tiktokInfo?.cookies).toBe(jar);
    expect(tiktokDownload?.cookies).toBe(`${jar}# rewritten by yt-dlp\n`);
    expect(otherInfo?.cookies).toBeNull();
    expect(await readFile(cookies, "utf8")).toBe(jar);
    await expect(access(dirname(copy))).rejects.toThrow();
  });

  it("skips impersonation and cookies yt-dlp cannot use", async () => {
    await useFake({
      targets: IMPERSONATE_TARGETS.replace("Chrome-136      Macos-15     curl_cffi", "Chrome          -            curl_cffi (unavailable)"),
    });
    process.env.VIDEOBOOK_YTDLP_COOKIES = join(dir, "missing-cookies.txt");

    const session = await open(TIKTOK_URL);

    expect(session.args).toEqual([]);
  });

  it("retries transient TikTok failures with exponential backoff", async () => {
    const ytdlp = await useFake({ failures: { info: 2 } });
    const session = await open(TIKTOK_URL);

    await expect(fetchVideoInfo(ytdlp, TIKTOK_URL, session)).resolves.toMatchObject({ title: "Rank one" });

    expect(session.attempts).toBe(3);
    expect(await fakeCalls(dir, "info")).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  it("gives up after three retries and keeps the block as the reason", async () => {
    const ytdlp = await useFake({ failures: { download: 9 } });
    const session = await open(TIKTOK_URL);

    const failed = await downloadVideoFile(ytdlp, TIKTOK_URL, join(dir, "original.mp4"), undefined, session)
      .then(() => null, (error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect(classifyDownloadFailure((failed as Error).message)).toEqual({
      class: "forbidden",
      reason: "forbidden: 7430000000000000001: Unable to download webpage: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)",
      transient: true,
    });
    expect(session.attempts).toBe(4);
    expect(await fakeCalls(dir, "download")).toHaveLength(4);
    expect(sleeps).toEqual([2_000, 4_000, 8_000]);
  });

  it("never retries permanent TikTok failures or other hosts", async () => {
    const ytdlp = await useFake({ failures: { info: 9 }, error: "[TikTok] 7430000000000000001: Video not available, status code 10231" });
    const tiktok = await open(TIKTOK_URL);
    await expect(fetchVideoInfo(ytdlp, TIKTOK_URL, tiktok)).rejects.toThrow("Video not available, status code 10231");
    expect(tiktok.attempts).toBe(1);

    await useFake({ failures: { info: 9 } });
    const other = await open(OTHER_URL);
    await expect(fetchVideoInfo(ytdlp, OTHER_URL, other)).rejects.toThrow("HTTP Error 403: Forbidden");
    expect(other.attempts).toBe(1);

    expect(await fakeCalls(dir, "info")).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  it("spaces TikTok downloads in one book by five seconds without delaying other books", async () => {
    await useFake();
    const book = randomUUID();

    await open(TIKTOK_URL, book);
    await open(TIKTOK_URL, book);
    expect(sleeps).toEqual([5_000]);
    await open(TIKTOK_URL, randomUUID());
    await open(OTHER_URL, book);
    expect(sleeps).toEqual([5_000]);
    await open(TIKTOK_URL, book);

    expect(sleeps).toEqual([5_000, 5_000]);
    expect(await fakeCalls(dir, "probe")).toHaveLength(1);
  });

  it("lets a stopped job give up its turn", async () => {
    configureDownloadClockForTests(null);
    await useFake();
    const book = randomUUID();
    await open(TIKTOK_URL, book);
    const stop = new AbortController();

    const waiting = openYtdlpSession({ url: TIKTOK_URL, bookId: book, binaryPath: fake, signal: stop.signal });
    stop.abort();

    await expect(waiting).rejects.toThrow(/abort/iu);
  });
});

describe("download_video job failure reasons", () => {
  const previousPath = process.env.VIDEOBOOK_YTDLP_PATH;
  let client: Client;
  let dir: string;
  let fakeDir: string;
  let engine: Engine;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  }, testBudget(30_000));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "videobook-download-job-"));
    fakeDir = await mkdtemp(join(tmpdir(), "videobook-download-job-ytdlp-"));
    client = await createTestClient(dir);
    engine = createEngineForTest(dir);
    registerJobHandler("process_video", async () => ({ stubbed: true }));
    await client.callTool({ name: "create_project", arguments: { book_id: "download-book" } });
  });

  afterEach(async () => {
    restoreEnv("VIDEOBOOK_YTDLP_PATH", previousPath);
    await client?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    await rm(fakeDir, { recursive: true, force: true });
  });

  async function startDownload(): Promise<{ artifactId: string; jobId: string }> {
    const result = await client.callTool({ name: "download_video", arguments: { url: OTHER_URL, book_id: "download-book" } });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}") as { artifact_id: string; job_id: string };
    return { artifactId: parsed.artifact_id, jobId: parsed.job_id };
  }

  it("records why a download failed so the cell can show it", async () => {
    process.env.VIDEOBOOK_YTDLP_PATH = await writeFakeYtdlp(fakeDir, { failures: { info: 1 }, error: "[generic] 1: Video unavailable" });
    const { artifactId, jobId } = await startDownload();

    await expect(waitForJob(jobId, testBudget(60_000))).rejects.toThrow(`Job ${jobId} failed: unavailable: 1: Video unavailable`);

    const recorded = await engine.metadata.artifacts.read<Record<string, unknown>>(artifactId, DOWNLOAD_FAILURE_METADATA_KEY);
    expect(recorded.ok && recorded.value).toMatchObject({
      class: "unavailable",
      reason: "unavailable: 1: Video unavailable",
      transient: false,
      attempts: 1,
      url: OTHER_URL,
    });
    const work = engine.jobs.artifactWork.read(artifactId);
    expect(work.ok && work.value?.meta.error?.message).toBe("unavailable: 1: Video unavailable");
    expect(await fakeCalls(fakeDir, "info")).toHaveLength(1);
  });

  it("clears the reason once a retried download succeeds and keeps today's arguments for other hosts", async () => {
    process.env.VIDEOBOOK_YTDLP_PATH = await writeFakeYtdlp(fakeDir, { failures: { info: 1 } });
    const { artifactId, jobId } = await startDownload();
    await expect(waitForJob(jobId, testBudget(60_000))).rejects.toThrow("forbidden: 7430000000000000001: Unable to download webpage");
    expect(await fakeCalls(fakeDir, "info")).toHaveLength(1);

    const artifact = engine.artifacts.get(artifactId);
    if (!artifact.ok) throw new Error(artifact.error.message);
    const retryId = `download-retry-${artifactId}`;
    await queue.enqueue(retryId, {
      type: "download_video",
      url: OTHER_URL,
      outputPath: join(artifact.value.path, "original.mp4"),
      assetId: artifactId,
      assetDir: artifact.value.path,
      bookId: engine.book.get().bookId,
      exportVideos: false,
      full: true,
      sourcePrefix: "127.0.0.1",
    });
    await waitForJob(retryId, testBudget(60_000));

    expect((await engine.metadata.artifacts.read(artifactId, DOWNLOAD_FAILURE_METADATA_KEY)).ok).toBe(false);
    const info = (await fakeCalls(fakeDir, "info")).at(-1);
    const download = (await fakeCalls(fakeDir, "download")).at(-1);
    expect(info?.args.slice(0, 4)).toEqual(["--flat-playlist", "--js-runtime", "node", "--dump-single-json"]);
    expect(info?.args.slice(-4)).toEqual(["--progress", "--newline", "--", OTHER_URL]);
    expect(download?.args.slice(-7)).toEqual(["--progress", "--newline", "--merge-output-format", "mp4", "--no-playlist", "--", OTHER_URL]);
    expect(await fakeCalls(fakeDir, "probe")).toEqual([]);
  });
});
