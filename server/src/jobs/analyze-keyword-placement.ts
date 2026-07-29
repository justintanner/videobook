import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenAiResponseInputContent } from "@apicity/openai";
import type { Engine } from "videobook-engine";
import sharp from "sharp";
import { z } from "zod";
import { getApiKey } from "../api-key.js";
import { runFfmpeg, probeVideo } from "../ffmpeg.js";
import {
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";
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

export interface ExtractedKeywordFrame {
  cueId: string;
  text: string;
  frameTime: number;
  buffer: Buffer;
}

export interface AnalyzeKeywordPlacementResult {
  analysis: KeywordPlacementAnalysis;
}

const VISION_JSON_SCHEMA = {
  type: "object",
  required: ["frames"],
  additionalProperties: false,
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        required: ["cue_id", "occupied_regions"],
        additionalProperties: false,
        properties: {
          cue_id: { type: "string" },
          occupied_regions: {
            type: "array",
            items: {
              type: "object",
              required: ["kind", "confidence", "x", "y", "width", "height"],
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["face", "text", "graphic"] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                x: { type: "number", minimum: 0, maximum: 1000 },
                y: { type: "number", minimum: 0, maximum: 1000 },
                width: { type: "number", minimum: 0.001, maximum: 1000 },
                height: { type: "number", minimum: 0.001, maximum: 1000 },
              },
            },
          },
        },
      },
    },
  },
} as const;

const regionSchema = z.object({
  kind: z.enum(["face", "text", "graphic"]),
  confidence: z.number().min(0).max(1),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  width: z.number().positive().max(1000),
  height: z.number().positive().max(1000),
}).strict().refine(
  (region) => region.x + region.width <= 1000.001 && region.y + region.height <= 1000.001,
  { message: "occupied region extends beyond the frame" },
);

const visionOutputSchema = z.object({
  frames: z.array(z.object({
    cue_id: z.string().min(1),
    occupied_regions: z.array(regionSchema),
  }).strict()),
}).strict();

const SYSTEM_PROMPT = `You are a precise video-layout analyst. Each attached image is a frame extracted at the exact midpoint of a spoken keyword.

For every frame, identify all occupied regions that cinematic keyword typography must not cover:
- every visible human face, including partial faces and faces in posters or screens
- every existing visible text block, subtitle, caption, title, logo, watermark, or graphic

Return one entry for every cue_id. Coordinates use a normalized image scale from 0 to 1000: x and y are the top-left corner, followed by width and height. Use tight boxes around the visible occupied content. Do not return boxes for bodies, clothing, scenery, microphones, or ordinary objects. Return an empty occupied_regions array only when none of the listed content is visible. Never omit, rename, or duplicate a cue_id.`;

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

function parseVisionRegions(
  raw: string,
  frames: ExtractedKeywordFrame[],
): Map<string, KeywordOccupiedRegion[]> {
  let parsed: z.infer<typeof visionOutputSchema>;
  try {
    parsed = visionOutputSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Keyword placement vision response was invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const expected = frames.map((frame) => frame.cueId);
  const actual = parsed.frames.map((frame) => frame.cue_id);
  if (actual.length !== expected.length
    || new Set(actual).size !== actual.length
    || expected.some((cueId) => !actual.includes(cueId))) {
    throw new Error("Keyword placement vision response did not contain exactly one result per cue");
  }
  return new Map(parsed.frames.map((frame) => [
    frame.cue_id,
    frame.occupied_regions.map((region): KeywordOccupiedRegion => ({
      kind: region.kind,
      confidence: region.confidence,
      x: region.x / 1000,
      y: region.y / 1000,
      width: region.width / 1000,
      height: region.height / 1000,
    })),
  ]));
}

async function analyzeFrames(
  frames: ExtractedKeywordFrame[],
  apiKey: string,
  signal: AbortSignal,
): Promise<Map<string, KeywordOccupiedRegion[]>> {
  const content: OpenAiResponseInputContent[] = [];
  for (const frame of frames) {
    content.push(
      {
        type: "input_text",
        text: `cue_id=${frame.cueId}; keyword=${frame.text}; timestamp=${frame.frameTime.toFixed(3)}s`,
      },
      {
        type: "input_image",
        image_url: `data:image/jpeg;base64,${frame.buffer.toString("base64")}`,
        detail: "high",
      },
    );
  }
  const responses = buildIntelligenceResponses(apiKey, { timeout: 240_000 });
  const response = await responses(intelligenceRequest({
    instructions: SYSTEM_PROMPT,
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: "keyword_placement_analysis",
        schema: VISION_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 8192,
  }), signal);
  return parseVisionRegions(firstResponseText(response), frames);
}

async function writeContactSheetIfChanged(
  fs: Engine,
  assetId: string,
  bookId: string,
  contactSheet: Buffer,
): Promise<void> {
  const existing = await fs.files.read(assetId, KEYWORD_FRAME_CACHE_FILENAME);
  if (existing.ok && existing.value.equals(contactSheet)) return;
  const write = await fs.files.write(assetId, KEYWORD_FRAME_CACHE_FILENAME, contactSheet
  );
  if (!write.ok) throw new Error(`Failed to persist keyword frame cache: ${write.error.message}`);
}

export function registerAnalyzeKeywordPlacementJob(fs: Engine): void {
  registerJobHandler("analyze_keyword_placement", async (payload, ctx) => {
    const {
      assetId,
      assetDir,
      bookId,
      videoPath,
      fingerprint,
      graphics,
    } = payload as AnalyzeKeywordPlacementPayload;
    return withLockedLocalLease(
      fs,
      bookId,
      assetId,
      assetDir,
      ctx,
      "analyze",
      { durationMs: LOCK_DURATION_MS, data: { state: "analyzing-keyword-placement" } },
      async () => {
        const apiKey = getApiKey("OPENAI_API_KEY");
        if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
        const probe = await probeVideo(videoPath, { signal: ctx.signal });
        const extracted = await extractKeywordFrames(videoPath, graphics, probe.duration, ctx.signal);
        const regions = await analyzeFrames(extracted.frames, apiKey, ctx.signal);
        const analysis: KeywordPlacementAnalysis = {
          version: KEYWORD_PLACEMENT_VERSION,
          fingerprint,
          sourceWidth: probe.width,
          sourceHeight: probe.height,
          frameCacheFilename: KEYWORD_FRAME_CACHE_FILENAME,
          analyzedAt: new Date().toISOString(),
          cues: extracted.frames.map((frame) => ({
            cueId: frame.cueId,
            text: frame.text,
            frameTime: frame.frameTime,
            regions: regions.get(frame.cueId) ?? [],
          })),
        };
        await writeContactSheetIfChanged(fs, assetId, bookId, extracted.contactSheet);
        await writeKeywordPlacementAnalysis(fs, assetId, bookId, analysis);
        return { analysis } satisfies AnalyzeKeywordPlacementResult;
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );
  });
}
