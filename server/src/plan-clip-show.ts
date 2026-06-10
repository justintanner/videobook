import type { AssetManifestFile, VideocityFs } from "videocity-engine";
import { findVideoFile } from "videocity-engine";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createOpenAi, firstContent, imageBase64Part, textPart, withRetry } from "@apicity/openai";
import type { OpenAiContentPart } from "@apicity/openai";
import { z } from "zod";
import { CHARACTER_METADATA_KEY, type Character } from "./jobs/extract-character.js";
import type { ClipShowCharacter, ClipShowPlanSidecar, ClipShowPlacement, ClipShowSegment } from "./plan-types.js";

const MODEL = "gpt-5.5";
const MAX_CLIPS = 8;
const DEFAULT_TONE = "sharp, playful, punchy, not mean";
const DEFAULT_VIDEO_DURATION_S = 6;

type OriginalMeta = {
  width?: number;
  height?: number;
  duration?: number;
  hasAudio?: boolean;
};

type PriorVideoAnalysis = {
  summary?: string;
  mood?: string;
  scenes?: Array<{ timestamp?: number; description?: string }>;
};

type ClipContext = {
  assetId: string;
  meta: OriginalMeta | null;
  transcript: string | null;
  prior: PriorVideoAnalysis | null;
  thumbnail: Buffer | null;
};

const GeneratedSegmentSchema = z.object({
  clip_asset_id: z.string(),
  clip_summary: z.string().min(1),
  placement: z.enum(["before", "after", "both"]),
  intro_dialog: z.string(),
  outro_dialog: z.string(),
  dialog: z.string().min(1),
  joke_notes: z.string(),
  quality_notes: z.string(),
  first_frame_prompt: z.string().min(20),
  video_prompt: z.string().min(20),
});

const GeneratedPlanSchema = z.object({
  segments: z.array(GeneratedSegmentSchema).min(1),
});

const GENERATED_PLAN_JSON_SCHEMA = {
  type: "object",
  required: ["segments"],
  additionalProperties: false,
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        required: [
          "clip_asset_id",
          "clip_summary",
          "placement",
          "intro_dialog",
          "outro_dialog",
          "dialog",
          "joke_notes",
          "quality_notes",
          "first_frame_prompt",
          "video_prompt",
        ],
        additionalProperties: false,
        properties: {
          clip_asset_id: { type: "string" },
          clip_summary: { type: "string" },
          placement: { type: "string", enum: ["before", "after", "both"] },
          intro_dialog: { type: "string" },
          outro_dialog: { type: "string" },
          dialog: { type: "string" },
          joke_notes: { type: "string" },
          quality_notes: { type: "string" },
          first_frame_prompt: { type: "string" },
          video_prompt: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are the writer/showrunner for a short Clip Show format.

The show has one recurring host character and a set of video clips. For each clip, write tight host commentary that can happen before the clip, after the clip, or both. The jokes should be specific to the clip, quick, visual, and easy to perform in a single-character talking-head video.

For every clip:
- Use the clip context and thumbnail to understand what the audience sees.
- Write one short intro joke and/or one short outro joke.
- Combine the spoken lines into dialog suitable for ElevenLabs text-to-speech.
- Avoid generic internet-commentary filler.
- Keep the character likable. Punch at the situation, timing, contradiction, or visual detail, not at protected traits.
- Self-check the comedy. Revise until the line has a clear premise, turn, and payoff.
- Write a first-frame prompt for generating a 16:9 image of the host about to deliver the line.
- Write a Seedance image-to-video prompt that uses the generated first frame and the dialog as performance direction.

Return JSON only.`;

function stripAt(value: string): string {
  return value.replace(/^@/, "").trim();
}

function decodeBuffer(buf: Buffer | string | Uint8Array): string {
  if (typeof buf === "string") return buf;
  return new TextDecoder().decode(buf);
}

function clipText(value: string, maxChars: number): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function characterDescription(profile: Character): string {
  const parts: string[] = [];
  if (profile.subject_kind) parts.push(`kind=${profile.subject_kind}`);
  for (const key of ["age", "ethnicity", "height", "build", "face", "hair", "eyes", "skin", "other"] as const) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) parts.push(`${key}=${value.trim()}`);
  }
  if (profile.wardrobe?.length) parts.push(`wardrobe=${profile.wardrobe.join(", ")}`);
  return parts.join("; ");
}

async function loadClipShowCharacter(
  fs: VideocityFs,
  projectSlug: string,
  rawAssetId: string,
): Promise<ClipShowCharacter> {
  const assetId = stripAt(rawAssetId);
  if (!assetId.startsWith("char-")) throw new Error(`character_asset_id must be a char-* asset, got: ${assetId}`);
  const read = await fs.readMetadata<Character>(assetId, CHARACTER_METADATA_KEY, projectSlug);
  if (!read.ok) throw new Error(`Failed to read .character.json for ${assetId}: ${read.error.message}`);
  const voiceId = read.value.elevenlabs_voice_id?.trim();
  if (!voiceId) throw new Error(`${assetId} has no ElevenLabs voice assigned`);
  return {
    asset_id: assetId,
    name: read.value.name?.trim() || assetId.replace(/^char-/, ""),
    description: characterDescription(read.value),
    elevenlabs_voice_id: voiceId,
  };
}

async function readOptionalText(fs: VideocityFs, assetId: string, filename: string, projectSlug: string): Promise<string | null> {
  const read = await fs.readFile(assetId, filename, projectSlug);
  return read.ok ? decodeBuffer(read.value) : null;
}

async function readTranscript(fs: VideocityFs, assetId: string, projectSlug: string): Promise<string | null> {
  const eleven = await readOptionalText(fs, assetId, "elevenlabs.json", projectSlug);
  if (eleven) {
    try {
      const parsed = JSON.parse(eleven) as { text?: unknown; words?: Array<{ text?: unknown; type?: unknown }> };
      if (typeof parsed.text === "string" && parsed.text.trim()) return clipText(parsed.text, 1600);
      if (Array.isArray(parsed.words)) {
        const text = parsed.words
          .filter((w) => w.type === "word" && typeof w.text === "string")
          .map((w) => w.text)
          .join(" ");
        if (text.trim()) return clipText(text, 1600);
      }
    } catch {
      return clipText(eleven, 1600);
    }
  }
  const gpt = await readOptionalText(fs, assetId, ".analysis.gpt4otrans.json", projectSlug);
  if (!gpt) return null;
  try {
    const parsed = JSON.parse(gpt) as { text?: unknown };
    return typeof parsed.text === "string" && parsed.text.trim() ? clipText(parsed.text, 1600) : null;
  } catch {
    return clipText(gpt, 1600);
  }
}

async function readPriorAnalysis(fs: VideocityFs, assetId: string, projectSlug: string): Promise<PriorVideoAnalysis | null> {
  const raw = await readOptionalText(fs, assetId, ".original.analysis.json", projectSlug);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PriorVideoAnalysis;
  } catch {
    return null;
  }
}

function findThumbnailFile(files: AssetManifestFile[]): AssetManifestFile | null {
  return files.find((f) => f.name === "original.jpg")
    ?? files.find((f) => f.name === "landscape.jpg")
    ?? files.find((f) => f.name === "portrait.jpg")
    ?? files.find((f) => f.name === "square.jpg")
    ?? null;
}

async function loadClipContext(fs: VideocityFs, projectSlug: string, rawAssetId: string): Promise<ClipContext> {
  const assetId = stripAt(rawAssetId);
  if (!assetId.startsWith("vid-")) throw new Error(`clip asset IDs must be vid-* assets, got: ${assetId}`);
  const manifest = await fs.getManifest(assetId, projectSlug, { includeDotfiles: true });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const videoFile = findVideoFile(manifest.value.files);
  if (!videoFile) throw new Error(`No video file found in asset ${assetId}`);
  const metaResult = await fs.readMetadata<OriginalMeta>(assetId, "original", projectSlug);
  const thumbFile = findThumbnailFile(manifest.value.files);
  let thumbnail: Buffer | null = null;
  if (thumbFile) {
    const read = await fs.readFile(assetId, thumbFile.name, projectSlug);
    if (read.ok) thumbnail = Buffer.from(read.value);
  }
  return {
    assetId,
    meta: metaResult.ok ? metaResult.value : null,
    transcript: await readTranscript(fs, assetId, projectSlug),
    prior: await readPriorAnalysis(fs, assetId, projectSlug),
    thumbnail,
  };
}

function normalizeClipIds(rawClipIds: string[]): string[] {
  const out: string[] = [];
  for (const raw of rawClipIds) {
    const id = stripAt(raw);
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  if (out.length === 0) throw new Error("At least one video clip is required");
  if (out.length > MAX_CLIPS) throw new Error(`At most ${MAX_CLIPS} clips are supported per Clip Show plan`);
  return out;
}

function clipContextBlock(clip: ClipContext, index: number): string {
  const meta = clip.meta
    ? `${clip.meta.width ?? "?"}x${clip.meta.height ?? "?"}, duration=${typeof clip.meta.duration === "number" ? `${clip.meta.duration.toFixed(1)}s` : "unknown"}, hasAudio=${clip.meta.hasAudio ?? "unknown"}`
    : "metadata unavailable";
  const scenes = (clip.prior?.scenes ?? [])
    .map((s) => `t=${(s.timestamp ?? 0).toFixed(1)}s ${s.description ?? ""}`.trim())
    .filter(Boolean)
    .join("; ");
  return [
    `Clip ${index + 1}: @${clip.assetId}`,
    `Metadata: ${meta}`,
    `Prior summary: ${clip.prior?.summary ?? "n/a"}`,
    `Mood: ${clip.prior?.mood ?? "n/a"}`,
    `Scenes: ${scenes || "n/a"}`,
    `Transcript: ${clip.transcript ?? "n/a"}`,
  ].join("\n");
}

function buildUserContext(character: ClipShowCharacter, clips: ClipContext[], showBrief: string, tone: string): string {
  return [
    "Create a Clip Show plan.",
    "",
    `Host character: @${character.asset_id}`,
    `Host name: ${character.name}`,
    `Host description: ${character.description || "n/a"}`,
    `ElevenLabs voice id: ${character.elevenlabs_voice_id}`,
    `Show brief: ${showBrief || "React to each clip with concise jokes before and/or after."}`,
    `Tone: ${tone || DEFAULT_TONE}`,
    "",
    "Clips:",
    clips.map(clipContextBlock).join("\n\n"),
    "",
    "Dialog constraints:",
    "- Each intro_dialog/outro_dialog is 0-2 sentences.",
    "- Use an empty string when a before/after line is not needed.",
    "- dialog is intro_dialog + outro_dialog combined in spoken order, suitable for TTS.",
    "- The host should sound like they watched the clip, not like they are reading a file summary.",
    "- first_frame_prompt must explicitly preserve @host identity from the reference image and create a clean talking-head first frame.",
    "- video_prompt must describe a short Seedance host performance and include the exact dialog line as spoken performance direction.",
  ].join("\n");
}

function buildUserContent(character: ClipShowCharacter, clips: ClipContext[], showBrief: string, tone: string): OpenAiContentPart[] {
  const parts: OpenAiContentPart[] = [textPart(buildUserContext(character, clips, showBrief, tone))];
  clips.forEach((clip, index) => {
    if (!clip.thumbnail) return;
    parts.push(textPart(`Thumbnail for Clip ${index + 1} (@${clip.assetId}) follows.`));
    parts.push(imageBase64Part(clip.thumbnail.toString("base64"), "image/jpeg", "low"));
  });
  return parts;
}

function normalizePlacement(value: ClipShowPlacement): ClipShowPlacement {
  return value === "after" || value === "both" ? value : "before";
}

function normalizeGeneratedSegments(
  generated: z.infer<typeof GeneratedPlanSchema>["segments"],
  clips: ClipContext[],
): ClipShowSegment[] {
  const byId = new Map(generated.map((segment) => [stripAt(segment.clip_asset_id), segment]));
  return clips.map((clip, index) => {
    const segment = byId.get(clip.assetId) ?? generated[index];
    if (!segment) throw new Error(`Model did not return a segment for ${clip.assetId}`);
    const intro = segment.intro_dialog.trim();
    const outro = segment.outro_dialog.trim();
    const dialog = segment.dialog.trim() || [intro, outro].filter(Boolean).join(" ");
    return {
      clip_asset_id: clip.assetId,
      clip_summary: segment.clip_summary.trim(),
      placement: normalizePlacement(segment.placement),
      intro_dialog: intro,
      outro_dialog: outro,
      dialog,
      joke_notes: segment.joke_notes.trim(),
      quality_notes: segment.quality_notes.trim(),
      first_frame_prompt: segment.first_frame_prompt.trim(),
      video_prompt: segment.video_prompt.trim(),
      audio_asset_id: null,
      first_frame_asset_id: null,
      video_asset_id: null,
    };
  });
}

function estimateDialogSeconds(dialog: string): number {
  const words = dialog.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(3, Math.ceil(words / 2.4));
}

function estimateTotalDuration(clips: ClipContext[], segments: ClipShowSegment[]): number {
  const clipDuration = clips.reduce((sum, clip) => sum + (typeof clip.meta?.duration === "number" ? clip.meta.duration : 0), 0);
  const hostDuration = segments.reduce((sum, segment) => sum + estimateDialogSeconds(segment.dialog), 0);
  return Math.round((clipDuration + hostDuration) * 100) / 100;
}

function renderMarkdown(sidecar: ClipShowPlanSidecar): string {
  return [
    "# Plan: Clip Show",
    "",
    `**Host:** @${sidecar.character.asset_id} (${sidecar.character.name})`,
    `**Voice:** ${sidecar.character.elevenlabs_voice_id}`,
    `**Clips:** ${sidecar.clip_asset_ids.map((id) => `@${id}`).join(", ")}`,
    `**Model:** ${sidecar.model}`,
    `**Tone:** ${sidecar.tone}`,
    "",
    "## Show Brief",
    "",
    sidecar.show_brief || "React to each clip with concise jokes before and/or after.",
    "",
    ...sidecar.segments.flatMap((segment, index) => [
      `## Segment ${index + 1}: @${segment.clip_asset_id}`,
      "",
      `**Placement:** ${segment.placement}`,
      `**Audio:** ${segment.audio_asset_id ? `@${segment.audio_asset_id}` : "not generated"}`,
      `**First frame:** ${segment.first_frame_asset_id ? `@${segment.first_frame_asset_id}` : "not generated"}`,
      `**Video:** ${segment.video_asset_id ? `@${segment.video_asset_id}` : "not generated"}`,
      "",
      "### Clip Summary",
      "",
      segment.clip_summary,
      "",
      "### Dialog",
      "",
      segment.dialog,
      "",
      "### Joke Notes",
      "",
      segment.joke_notes,
      "",
      "### Quality Notes",
      "",
      segment.quality_notes,
      "",
      "### First Frame Prompt",
      "",
      segment.first_frame_prompt,
      "",
      "### Video Prompt",
      "",
      segment.video_prompt,
      "",
    ]),
  ].join("\n");
}

export async function writeClipShowPlan(
  fs: VideocityFs,
  projectSlug: string,
  sidecar: ClipShowPlanSidecar,
): Promise<void> {
  const normalized: ClipShowPlanSidecar = {
    ...sidecar,
    video_model: "generate_seedance2_video",
  };
  const projectResult = await fs.getProject(projectSlug);
  if (!projectResult.ok) throw new Error(projectResult.error.message);
  await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

  const writeMd = await fs.writeFile("plan", "index.md", renderMarkdown(normalized), projectSlug);
  if (!writeMd.ok) throw new Error(`Failed to write index.md: ${writeMd.error.message}`);
  const writeJson = await fs.writeFile("plan", ".plan.json", JSON.stringify(normalized, null, 2), projectSlug);
  if (!writeJson.ok) throw new Error(`Failed to write .plan.json: ${writeJson.error.message}`);
}

export async function readClipShowPlan(fs: VideocityFs, projectSlug: string): Promise<ClipShowPlanSidecar> {
  const read = await fs.readMetadata<ClipShowPlanSidecar>("plan", "plan", projectSlug);
  if (!read.ok) throw new Error(read.error.message);
  if (read.value.formula !== "clip_show") throw new Error(`Current plan is ${read.value.formula ?? "char_swap"}, not clip_show`);
  return read.value;
}

export async function generateClipShowPlan(
  fs: VideocityFs,
  args: {
    projectSlug: string;
    characterAssetId: string;
    clipAssetIds: string[];
    showBrief?: string;
    tone?: string;
  },
): Promise<ClipShowPlanSidecar> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

  const clipIds = normalizeClipIds(args.clipAssetIds);
  const character = await loadClipShowCharacter(fs, args.projectSlug, args.characterAssetId);
  const clips: ClipContext[] = [];
  for (const clipId of clipIds) {
    clips.push(await loadClipContext(fs, args.projectSlug, clipId));
  }

  const showBrief = args.showBrief?.trim() ?? "";
  const tone = args.tone?.trim() || DEFAULT_TONE;
  const provider = createOpenAi({ apiKey, timeout: 240_000 });
  const call = withRetry(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

  const result = await call({
    model: MODEL,
    stream: false,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserContent(character, clips, showBrief, tone) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "clip_show_plan",
        schema: GENERATED_PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
        strict: true,
      },
    },
    max_completion_tokens: 8192,
  });

  const parsed = GeneratedPlanSchema.parse(JSON.parse(firstContent(result)));
  const segments = normalizeGeneratedSegments(parsed.segments, clips);
  const sidecar: ClipShowPlanSidecar = {
    formula: "clip_show",
    character,
    clip_asset_ids: clipIds,
    show_brief: showBrief,
    tone,
    model: MODEL,
    audio_model: "elevenlabs",
    first_frame_model: "generate_gpt_image",
    video_model: "generate_seedance2_video",
    video_resolution: "720p",
    video_aspect_ratio: "16:9",
    video_duration_s: DEFAULT_VIDEO_DURATION_S,
    total_duration_s: estimateTotalDuration(clips, segments),
    segments,
  };
  await writeClipShowPlan(fs, args.projectSlug, sidecar);
  return sidecar;
}
