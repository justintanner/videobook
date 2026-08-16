import { createHash } from "node:crypto";
import type { ArtifactManifestFile, Engine } from "videobook-engine";
import { z } from "zod";
import type { KeywordOccupiedRegion } from "./remotion/keyword-placement.js";
import type { Orientation, OsgPosition } from "./remotion/subtitles/types.js";

export const OSG_PLACEMENT_VERSION = 1;
const OSG_PLACEMENT_METADATA_KEY = "osg.placement";

export interface OsgPlacementAnalysis {
  version: number;
  fingerprint: string;
  sourceWidth: number;
  sourceHeight: number;
  frameTimes: number[];
  /** Union of occupied regions across every sampled frame, source-normalized. */
  regions: KeywordOccupiedRegion[];
  /** Winning corner per render orientation. */
  positions: Record<Orientation, OsgPosition>;
  analyzedAt: string;
}

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

const positionSchema = z.enum([
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
]);

const analysisSchema = z.object({
  version: z.literal(OSG_PLACEMENT_VERSION),
  fingerprint: z.string().min(1),
  sourceWidth: z.number().positive(),
  sourceHeight: z.number().positive(),
  frameTimes: z.array(z.number().nonnegative()).min(1),
  regions: z.array(regionSchema),
  positions: z.object({
    landscape: positionSchema,
    portrait: positionSchema,
    square: positionSchema,
  }).strict(),
  analyzedAt: z.string().min(1),
}).strict();

export function osgPlacementFingerprint(
  videoFile: ArtifactManifestFile,
  frameNames: string[],
  box: { aspect: number; minDimFraction: number; userScale: number },
): string {
  const payload = {
    version: OSG_PLACEMENT_VERSION,
    video: {
      name: videoFile.name,
      size: videoFile.sizeBytes,
      objectHash: videoFile.objectHash,
    },
    frames: frameNames,
    box: {
      aspect: Number(box.aspect.toFixed(4)),
      minDimFraction: box.minDimFraction,
      userScale: Number(box.userScale.toFixed(2)),
    },
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function parseOsgPlacementAnalysis(raw: unknown): OsgPlacementAnalysis {
  return analysisSchema.parse(raw) as OsgPlacementAnalysis;
}

export async function readOsgPlacementAnalysis(
  fs: Engine,
  assetId: string,
): Promise<OsgPlacementAnalysis | null> {
  const result = await fs.metadata.artifacts.read<unknown>(assetId, OSG_PLACEMENT_METADATA_KEY);
  if (!result.ok) return null;
  const parsed = analysisSchema.safeParse(result.value);
  return parsed.success ? parsed.data as OsgPlacementAnalysis : null;
}

export async function writeOsgPlacementAnalysis(
  fs: Engine,
  assetId: string,
  analysis: OsgPlacementAnalysis,
): Promise<void> {
  const parsed = parseOsgPlacementAnalysis(analysis);
  const result = await fs.metadata.artifacts.write(assetId, OSG_PLACEMENT_METADATA_KEY, parsed);
  if (!result.ok) throw new Error(`Failed to persist OSG placement analysis: ${result.error.message}`);
}
