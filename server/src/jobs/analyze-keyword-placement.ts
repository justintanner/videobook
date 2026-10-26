import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Engine } from "videobook-engine";
import sharp from "sharp";
import { getApiKey } from "../api-key.js";
import { runFfmpeg, probeVideo } from "../ffmpeg.js";
import { fileObjectHash } from "../analysis-sidecars.js";
import { frameRegionsAt } from "../frame-regions.js";
import { writeKeywordPlacementAnalysis } from "../keyword-placement-cache.js";
import { registerJobHandler } from "../queue.js";
import {
  KEYWORD_FRAME_CACHE_FILENAME,
  KEYWORD_PLACEMENT_VERSION,
  keywordCueId,
} from "../remotion/keyword-placement.js";
import type {
  KeywordOccupiedRegion,
  KeywordPlacementAnalysis,
} from "../remotion/keyword-placement.js";
import type { KeywordGraphic } from "../remotion/subtitles/types.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 300_000;
const CELL_WIDTH = 640;
const IMAGE_HEIGHT = 360;
const LABEL_HEIGHT = 48;
const CELL_HEIGHT = IMAGE_HEIGHT + LABEL_HEIGHT;
const CONTACT_SHEET_COLUMNS = 2;

type AnalyzeKeywordPlacementPayload = {
  type: "analyze_keyword_placement";
  assetId: string;
  assetDir: string;
  bookId: string;
  videoPath: string;
  fingerprint: string;
  graphics: KeywordGraphic[];
};

interface ExtractedKeywordFrame {
  cueId: string;
  text: string;
  frameTime: number;
  buffer: Buffer;
}

export interface AnalyzeKeywordPlacementResult {
  analysis: KeywordPlacementAnalysis;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function createContactSheet(frames: ExtractedKeywordFrame[]): Promise<Buffer> {
  const cells = await Promise.all(frames.map(async (frame) => {
    const image = await sharp(frame.buffer)
      .resize({
        width: CELL_WIDTH,
        height: IMAGE_HEIGHT,
        fit: "contain",
        background: "#080808",
      })
      .jpeg({ quality: 88 })
      .toBuffer();
    const label = Buffer.from(
      `<svg width="${CELL_WIDTH}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#080808"/><text x="18" y="32" fill="#ffffff" font-family="serif" font-size="22">${escapeXml(frame.text)} · ${frame.frameTime.toFixed(3)}s</text></svg>`,
    );
    return sharp({
      create: {
        width: CELL_WIDTH,
        height: CELL_HEIGHT,
        channels: 3,
        background: "#080808",
      },
    }).composite([
      { input: label, left: 0, top: 0 },
      { input: image, left: 0, top: LABEL_HEIGHT },
    ]).jpeg({ quality: 88 }).toBuffer();
  }));
  const rows = Math.ceil(cells.length / CONTACT_SHEET_COLUMNS);
  return sharp({
    create: {
      width: CELL_WIDTH * CONTACT_SHEET_COLUMNS,
      height: CELL_HEIGHT * rows,
      channels: 3,
      background: "#080808",
    },
  }).composite(cells.map((input, index) => ({
    input,
    left: index % CONTACT_SHEET_COLUMNS * CELL_WIDTH,
    top: Math.floor(index / CONTACT_SHEET_COLUMNS) * CELL_HEIGHT,
  }))).jpeg({ quality: 88 }).toBuffer();
}

export async function extractKeywordFrames(
  videoPath: string,
  graphics: KeywordGraphic[],
  duration: number,
  signal?: AbortSignal,
): Promise<{ frames: ExtractedKeywordFrame[]; contactSheet: Buffer }> {
  const tempDir = await mkdtemp(join(tmpdir(), "videocity-keyword-frames-"));
  try {
    const frames: ExtractedKeywordFrame[] = [];
    for (let index = 0; index < graphics.length; index++) {
      signal?.throwIfAborted();
      const graphic = graphics[index];
      const requestedTime = graphic.frameTime ?? graphic.start;
      const frameTime = Math.max(0, Math.min(Math.max(0, duration - 0.05), requestedTime));
      const framePath = join(tempDir, `${index.toString().padStart(2, "0")}.jpg`);
      await runFfmpeg([
        "-y",
        "-ss", frameTime.toFixed(6),
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease",
        "-q:v", "2",
        framePath,
      ], { signal });
      frames.push({
        cueId: keywordCueId(graphic),
        text: graphic.text,
        frameTime,
        buffer: await readFile(framePath),
      });
    }
    return { frames, contactSheet: await createContactSheet(frames) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function analyzeFrames(
  engine: Engine,
  assetId: string,
  videoPath: string,
  frames: ExtractedKeywordFrame[],
  signal: AbortSignal,
): Promise<KeywordOccupiedRegion[][]> {
  const mediaHash = await fileObjectHash(engine, assetId, basename(videoPath));
  if (!mediaHash) throw new Error(`The video for ${assetId} changed while keyword placement was being analysed. Run it again.`);
  const byTime = new Map(frames.map((frame) => [frame.frameTime, frame.buffer]));
  const regions = await frameRegionsAt({
    engine,
    artifactId: assetId,
    mediaHash,
    times: frames.map((frame) => frame.frameTime),
    frames: async (times) => times.map((time) => byTime.get(time) ?? Buffer.alloc(0)),
    apiKey: getApiKey("OPENAI_API_KEY"),
    signal,
  });
  return regions.map((frame) => frame.regions);
}

async function writeContactSheetIfChanged(
  engine: Engine,
  assetId: string,
  contactSheet: Buffer,
): Promise<void> {
  const existing = await engine.files.read(assetId, KEYWORD_FRAME_CACHE_FILENAME);
  if (existing.ok && existing.value.equals(contactSheet)) return;
  const write = await engine.files.write(assetId, KEYWORD_FRAME_CACHE_FILENAME, contactSheet
  );
  if (!write.ok) throw new Error(`Failed to persist keyword frame cache: ${write.error.message}`);
}

export function registerAnalyzeKeywordPlacementJob(engine: Engine): void {
  registerJobHandler("analyze_keyword_placement", async (payload, ctx) => {
    const {
      assetId,
      assetDir,
      videoPath,
      fingerprint,
      graphics,
    } = payload as AnalyzeKeywordPlacementPayload;
    return withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "analyze",
      { durationMs: LOCK_DURATION_MS, data: { state: "analyzing-keyword-placement" } },
      async () => {
        const probe = await probeVideo(videoPath, { signal: ctx.signal });
        const extracted = await extractKeywordFrames(videoPath, graphics, probe.duration, ctx.signal);
        const regions = await analyzeFrames(engine, assetId, videoPath, extracted.frames, ctx.signal);
        const analysis: KeywordPlacementAnalysis = {
          version: KEYWORD_PLACEMENT_VERSION,
          fingerprint,
          sourceWidth: probe.width,
          sourceHeight: probe.height,
          frameCacheFilename: KEYWORD_FRAME_CACHE_FILENAME,
          analyzedAt: new Date().toISOString(),
          cues: extracted.frames.map((frame, index) => ({
            cueId: frame.cueId,
            text: frame.text,
            frameTime: frame.frameTime,
            regions: regions[index] ?? [],
          })),
        };
        await writeContactSheetIfChanged(engine, assetId, extracted.contactSheet);
        await writeKeywordPlacementAnalysis(engine, assetId, analysis);
        return { analysis } satisfies AnalyzeKeywordPlacementResult;
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );
  });
}
