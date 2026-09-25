import { z } from "zod";
import type { AliveSettings } from "../remotion/subtitles/alive-types.js";
import { ALIVE_MOTIONS, ALIVE_STYLES } from "../remotion/subtitles/alive-types.js";

/** Client-safe (zod only) schemas for stored alive caption analysis and settings. */

export const ALIVE_ANALYSIS_VERSION = 1;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const aliveSettingsSchema = z.object({
  style: z.enum(ALIVE_STYLES as [AliveSettings["style"], ...AliveSettings["style"][]]),
  motion: z.enum(ALIVE_MOTIONS as [AliveSettings["motion"], ...AliveSettings["motion"][]]),
  energySizing: z.boolean(),
  snapToOnsets: z.boolean(),
  avoidFaces: z.boolean(),
  avoidText: z.boolean(),
  textColor: hexColor,
  hitColor: hexColor,
}).strict();

const regionSchema = z.object({
  kind: z.enum(["face", "text", "graphic"]),
  confidence: z.number().min(0).max(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict();

const wordSchema = z.object({
  text: z.string().min(1),
  transcriptStart: z.number().nonnegative(),
  transcriptEnd: z.number().nonnegative(),
  onsetStart: z.number().nonnegative(),
  energy: z.number().min(0).max(1),
}).strict();

const phraseSchema = z.object({
  id: z.string().min(1),
  frameTime: z.number().nonnegative(),
  regions: z.array(regionSchema),
  lines: z.array(z.array(wordSchema).min(1)).min(1),
}).strict();

export const aliveAnalysisSchema = z.object({
  version: z.literal(ALIVE_ANALYSIS_VERSION),
  fingerprint: z.string().min(1),
  analyzedAt: z.string().min(1),
  durationSeconds: z.number().nonnegative(),
  sourceWidth: z.number().positive(),
  sourceHeight: z.number().positive(),
  envelopeHz: z.number().positive(),
  envelope: z.array(z.number().min(0).max(1)),
  onsets: z.array(z.number().nonnegative()),
  regionsAnalyzed: z.boolean(),
  phrases: z.array(phraseSchema),
}).strict();
