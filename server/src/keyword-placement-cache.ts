import { createHash } from "node:crypto";
import type { ArtifactManifestFile, Engine } from "videobook-engine";
import { z } from "zod";
import {
  KEYWORD_FRAME_CACHE_FILENAME,
  KEYWORD_PLACEMENT_METADATA_KEY,
  KEYWORD_PLACEMENT_VERSION,
  keywordCueId,
} from "./remotion/keyword-placement.js";
import type {
  KeywordPlacementAnalysis,
  KeywordPlacementCueAnalysis,
} from "./remotion/keyword-placement.js";
import type { KeywordGraphic } from "./remotion/subtitles/types.js";

const regionSchema = z.object({
  kind: z.enum(["face", "text", "graphic"]),
  confidence: z.number().min(0).max(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().refine(
  (region) => region.x + region.width <= 1.001 && region.y + region.height <= 1.001,
  { message: "occupied region extends beyond the source frame" },
);

const cueSchema = z.object({
  cueId: z.string().min(1),
  text: z.string().min(1),
  frameTime: z.number().nonnegative(),
  regions: z.array(regionSchema),
}).strict();

const analysisSchema = z.object({
  version: z.literal(KEYWORD_PLACEMENT_VERSION),
  fingerprint: z.string().min(1),
  sourceWidth: z.number().positive(),
  sourceHeight: z.number().positive(),
  frameCacheFilename: z.literal(KEYWORD_FRAME_CACHE_FILENAME),
  analyzedAt: z.string().min(1),
  cues: z.array(cueSchema).min(1),
}).strict();

export function keywordPlacementFingerprint(
  videoFile: ArtifactManifestFile,
  transcript: Buffer,
  graphics: KeywordGraphic[],
): string {
  const transcriptHash = createHash("sha256").update(transcript).digest("hex");
  const payload = {
    version: KEYWORD_PLACEMENT_VERSION,
    video: {
      name: videoFile.name,
      size: videoFile.sizeBytes,
      modified: videoFile.mtimeMs,
    },
    transcriptHash,
    cues: graphics.map((graphic) => ({
      id: keywordCueId(graphic),
      text: graphic.text,
      start: graphic.start,
      end: graphic.end,
      frameTime: graphic.frameTime,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function parseKeywordPlacementAnalysis(raw: unknown): KeywordPlacementAnalysis {
  return analysisSchema.parse(raw) as KeywordPlacementAnalysis;
}

export async function readKeywordPlacementAnalysis(
  fs: Engine,
  assetId: string,
  _bookId: string,
): Promise<KeywordPlacementAnalysis | null> {
  const result = await fs.metadata.artifacts.read<unknown>(assetId, KEYWORD_PLACEMENT_METADATA_KEY
  );
  if (!result.ok) return null;
  const parsed = analysisSchema.safeParse(result.value);
  return parsed.success ? parsed.data as KeywordPlacementAnalysis : null;
}

export async function writeKeywordPlacementAnalysis(
  fs: Engine,
  assetId: string,
  bookId: string,
  analysis: KeywordPlacementAnalysis,
): Promise<void> {
  const parsed = parseKeywordPlacementAnalysis(analysis);
  const result = await fs.metadata.artifacts.write(assetId, KEYWORD_PLACEMENT_METADATA_KEY, parsed
  );
  if (!result.ok) throw new Error(`Failed to persist keyword placement analysis: ${result.error.message}`);
}

export async function isKeywordPlacementCacheValid(
  fs: Engine,
  assetId: string,
  bookId: string,
  analysis: KeywordPlacementAnalysis | null,
  fingerprint: string,
  graphics: KeywordGraphic[],
): Promise<boolean> {
  if (!analysis || analysis.fingerprint !== fingerprint) return false;
  const expectedCueIds = graphics.map(keywordCueId);
  const cachedCueIds = analysis.cues.map((cue: KeywordPlacementCueAnalysis) => cue.cueId);
  if (expectedCueIds.length !== cachedCueIds.length) return false;
  if (expectedCueIds.some((cueId, index) => cueId !== cachedCueIds[index])) return false;
  const frameCache = await fs.files.read(assetId, KEYWORD_FRAME_CACHE_FILENAME);
  return frameCache.ok;
}
