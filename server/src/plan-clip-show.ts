import type { VideocityFs } from "videocity-engine";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createOpenAi, firstContent, imageBase64Part, textPart, withRetry } from "@apicity/openai";
import type { OpenAiContentPart } from "@apicity/openai";
import { z } from "zod";
import { CHARACTER_METADATA_KEY, type Character } from "./jobs/extract-character.js";
import { findImageFile } from "./tools/_image-inputs.js";
import { mimeForImageFilename } from "./jobs/describe-image.js";
import { DEFAULT_JOKE_TYPE, jokeTypeHint, normalizeJokeType } from "./clip-show-joke-types.js";
import type { ClipShowCharacter, ClipShowItem, ClipShowPlanSidecar, ClipShowSegment } from "./plan-types.js";

const MODEL = "gpt-5.5";
const MAX_ITEMS = 12;
const DEFAULT_TONE = "sharp, playful, punchy, not mean";

type LoadedImage = { bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" };

const GeneratedSegmentSchema = z.object({
  index: z.number().int(),
  source_summary: z.string().min(1),
  joke: z.string().min(1),
  joke_notes: z.string(),
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
        required: ["index", "source_summary", "joke", "joke_notes"],
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          source_summary: { type: "string" },
          joke: { type: "string" },
          joke_notes: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are the comedy writer for a short audio read-through hosted by one recurring character.

You receive an ordered list of ITEMS. Each item is either a text topic or an image (provided via vision). For every item, write exactly ONE spoken joke the host delivers as a voiceover.

For each item return:
- index: the item's position (echo the number you were given).
- source_summary: one short sentence describing the item (paraphrase the topic, or describe what you see in the image).
- joke: ONE punchy spoken line for ElevenLabs text-to-speech — a single clear premise, turn, and payoff. One or two sentences, no more. Plain spoken words only: no stage directions, no emoji, no markdown, no quotation marks around the line.
- joke_notes: optional one-line note on the comedic angle (may be empty).

Stay in the host's voice and the requested tone. Be specific to the item. Punch at the situation, timing, contradiction, or visual detail — never at protected traits. Keep the host likable.

If an item specifies a comedic style, write that joke in that style. Otherwise pick whatever angle lands best.

Return exactly one segment per input item, in the same order. Return JSON only.`;

function stripAt(value: string): string {
  return value.replace(/^@/, "").trim();
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

// Load an img-* asset's bytes for vision (mirrors plan-storyboard-video).
async function loadImageBytes(fs: VideocityFs, projectSlug: string, rawAssetId: string): Promise<LoadedImage | null> {
  const assetId = stripAt(rawAssetId);
  if (!assetId.startsWith("img-")) throw new Error(`image items must be img-* assets, got: ${assetId}`);
  const manifest = await fs.getManifest(assetId, projectSlug, { includeDotfiles: false });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findImageFile(manifest.value.files);
  if (!file) return null;
  const read = await fs.readFile(assetId, file.name, projectSlug);
  if (!read.ok) return null;
  return { bytes: Buffer.from(read.value), mime: mimeForImageFilename(file.name) };
}

function normalizeItems(raw: ClipShowItem[]): ClipShowItem[] {
  const out: ClipShowItem[] = [];
  const seenImages = new Set<string>();
  for (const item of raw) {
    if (item.kind === "topic") {
      const topic = item.topic.trim();
      if (topic) out.push({ kind: "topic", topic });
    } else {
      const id = stripAt(item.image_asset_id);
      if (id.startsWith("img-") && !seenImages.has(id)) {
        seenImages.add(id);
        out.push({ kind: "image", image_asset_id: id });
      }
    }
  }
  if (out.length === 0) throw new Error("At least one item (topic or image) is required");
  if (out.length > MAX_ITEMS) throw new Error(`At most ${MAX_ITEMS} items are supported per Clip Show plan`);
  return out;
}

function buildUserContent(
  character: ClipShowCharacter,
  items: ClipShowItem[],
  images: Map<string, LoadedImage>,
  jokeTypes: string[],
  showBrief: string,
  tone: string,
): OpenAiContentPart[] {
  const header = [
    "Write a comedy read-through.",
    "",
    `Host: ${character.name} (@${character.asset_id})`,
    `Host description: ${character.description || "n/a"}`,
    `Show brief: ${showBrief || "One quick joke per item."}`,
    `Tone: ${tone}`,
    "",
    `There are ${items.length} item(s). Write exactly one joke per item, in order, and echo each item's index.`,
    "",
    "Items:",
  ].join("\n");
  const parts: OpenAiContentPart[] = [textPart(header)];
  items.forEach((item, index) => {
    const hint = jokeTypeHint(jokeTypes[index]);
    const style = hint ? ` Comedic style: ${hint}` : "";
    if (item.kind === "topic") {
      parts.push(textPart(`Item ${index} (topic): ${item.topic}${style}`));
      return;
    }
    const img = images.get(item.image_asset_id);
    parts.push(textPart(`Item ${index} (image @${item.image_asset_id})${img ? " — image follows:" : " — (image unavailable; infer from the id)"}${style}`));
    if (img) parts.push(imageBase64Part(img.bytes.toString("base64"), img.mime, "low"));
  });
  return parts;
}

function normalizeGeneratedSegments(
  generated: z.infer<typeof GeneratedPlanSchema>["segments"],
  items: ClipShowItem[],
  jokeTypes: string[],
): ClipShowSegment[] {
  const byIndex = new Map<number, (typeof generated)[number]>();
  generated.forEach((segment, i) => {
    const idx = Number.isInteger(segment.index) ? segment.index : i;
    if (!byIndex.has(idx)) byIndex.set(idx, segment);
  });
  return items.map((item, index) => {
    const segment = byIndex.get(index) ?? generated[index];
    if (!segment) throw new Error(`Model did not return a joke for item ${index}`);
    const base =
      item.kind === "topic"
        ? { kind: "topic" as const, topic: item.topic }
        : { kind: "image" as const, image_asset_id: item.image_asset_id };
    const notes = segment.joke_notes.trim();
    return {
      ...base,
      source_summary: segment.source_summary.trim(),
      joke: segment.joke.trim(),
      ...(notes ? { joke_notes: notes } : {}),
      joke_type: normalizeJokeType(jokeTypes[index]),
      audio_asset_id: null,
    };
  });
}

function renderMarkdown(sidecar: ClipShowPlanSidecar): string {
  return [
    "# Plan: Clip Show (read-through)",
    "",
    `**Host:** @${sidecar.character.asset_id} (${sidecar.character.name})`,
    `**Voice:** ${sidecar.character.elevenlabs_voice_id}`,
    `**Model:** ${sidecar.model}`,
    `**Tone:** ${sidecar.tone}`,
    "",
    "## Show Brief",
    "",
    sidecar.show_brief || "One quick joke per item.",
    "",
    ...sidecar.segments.flatMap((segment, index) => {
      const source = segment.kind === "image" ? `@${segment.image_asset_id ?? "img"}` : segment.topic ?? "";
      const style = segment.joke_type && segment.joke_type !== DEFAULT_JOKE_TYPE ? ` (${segment.joke_type})` : "";
      return [
        `## Item ${index + 1} — ${source}`,
        "",
        `**Audio:** ${segment.audio_asset_id ? `@${segment.audio_asset_id}` : "not generated"}${style}`,
        "",
        "### Source",
        "",
        segment.source_summary,
        "",
        "### Joke",
        "",
        segment.joke,
        ...(segment.joke_notes ? ["", "### Notes", "", segment.joke_notes] : []),
        "",
      ];
    }),
  ].join("\n");
}

export async function writeClipShowPlan(
  fs: VideocityFs,
  projectSlug: string,
  sidecar: ClipShowPlanSidecar,
): Promise<void> {
  const projectResult = await fs.getProject(projectSlug);
  if (!projectResult.ok) throw new Error(projectResult.error.message);
  await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

  const writeMd = await fs.writeFile("plan", "index.md", renderMarkdown(sidecar), projectSlug);
  if (!writeMd.ok) throw new Error(`Failed to write index.md: ${writeMd.error.message}`);
  const writeJson = await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), projectSlug);
  if (!writeJson.ok) throw new Error(`Failed to write .plan.json: ${writeJson.error.message}`);
}

export async function readClipShowPlan(fs: VideocityFs, projectSlug: string): Promise<ClipShowPlanSidecar> {
  const read = await fs.readMetadata<ClipShowPlanSidecar>("plan", "plan", projectSlug);
  if (!read.ok) throw new Error(read.error.message);
  if (read.value.formula !== "clip_show") throw new Error(`Current plan is ${read.value.formula ?? "char_swap"}, not clip_show`);
  return read.value;
}

// Load every distinct image item's bytes for vision (skips topics, dedupes).
async function loadImagesForItems(
  fs: VideocityFs,
  projectSlug: string,
  items: ClipShowItem[],
): Promise<Map<string, LoadedImage>> {
  const images = new Map<string, LoadedImage>();
  for (const item of items) {
    if (item.kind === "image" && !images.has(item.image_asset_id)) {
      const loaded = await loadImageBytes(fs, projectSlug, item.image_asset_id);
      if (loaded) images.set(item.image_asset_id, loaded);
    }
  }
  return images;
}

// Run GPT-5.5 over the items and return normalized segments (1:1, in order).
// Shared by full-plan generation and single-segment regeneration.
async function generateSegments(args: {
  fs: VideocityFs;
  projectSlug: string;
  character: ClipShowCharacter;
  items: ClipShowItem[];
  jokeTypes: string[];
  showBrief: string;
  tone: string;
}): Promise<ClipShowSegment[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

  const images = await loadImagesForItems(args.fs, args.projectSlug, args.items);
  const provider = createOpenAi({ apiKey, timeout: 240_000 });
  const call = withRetry(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

  const result = await call({
    model: MODEL,
    stream: false,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserContent(args.character, args.items, images, args.jokeTypes, args.showBrief, args.tone) },
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
  return normalizeGeneratedSegments(parsed.segments, args.items, args.jokeTypes);
}

export async function generateClipShowPlan(
  fs: VideocityFs,
  args: {
    projectSlug: string;
    characterAssetId: string;
    items: ClipShowItem[];
    showBrief?: string;
    tone?: string;
  },
): Promise<ClipShowPlanSidecar> {
  const items = normalizeItems(args.items);
  const character = await loadClipShowCharacter(fs, args.projectSlug, args.characterAssetId);
  const showBrief = args.showBrief?.trim() ?? "";
  const tone = args.tone?.trim() || DEFAULT_TONE;

  const segments = await generateSegments({
    fs,
    projectSlug: args.projectSlug,
    character,
    items,
    jokeTypes: items.map(() => DEFAULT_JOKE_TYPE),
    showBrief,
    tone,
  });

  const sidecar: ClipShowPlanSidecar = {
    formula: "clip_show",
    character,
    show_brief: showBrief,
    tone,
    model: MODEL,
    audio_model: "elevenlabs",
    segments,
  };
  await writeClipShowPlan(fs, args.projectSlug, sidecar);
  return sidecar;
}

// Resolve which item a segment should be regenerated from: a swapped-in image
// (drag-and-drop replace) overrides; otherwise reuse the segment's own source.
function itemForRegeneration(segment: ClipShowSegment, newImageAssetId: string | null): ClipShowItem {
  if (newImageAssetId) {
    const id = stripAt(newImageAssetId);
    if (!id.startsWith("img-")) throw new Error(`image_asset_id must be an img-* asset, got: ${id}`);
    return { kind: "image", image_asset_id: id };
  }
  if (segment.kind === "image" && segment.image_asset_id) {
    return { kind: "image", image_asset_id: segment.image_asset_id };
  }
  if (segment.kind === "topic" && segment.topic) {
    return { kind: "topic", topic: segment.topic };
  }
  throw new Error("Segment has no source to regenerate from");
}

// Rewrite one segment's joke via GPT-5.5 — optionally with a new joke type
// and/or a swapped source image. Stale audio is cleared (the new joke no
// longer matches the old voiceover). Returns the full updated sidecar.
export async function regenerateClipShowSegment(
  fs: VideocityFs,
  args: {
    projectSlug: string;
    segmentIndex: number;
    jokeType?: string | null;
    newImageAssetId?: string | null;
  },
): Promise<ClipShowPlanSidecar> {
  const sidecar = await readClipShowPlan(fs, args.projectSlug);
  const existing = sidecar.segments[args.segmentIndex];
  if (!existing) throw new Error(`Clip Show segment ${args.segmentIndex} not found`);
  if (existing.joke === undefined || existing.kind === undefined) {
    throw new Error("This Clip Show plan uses the old format — regenerate it from /templates before editing.");
  }

  const item = itemForRegeneration(existing, args.newImageAssetId ?? null);
  const jokeType = normalizeJokeType(args.jokeType ?? existing.joke_type);

  const [segment] = await generateSegments({
    fs,
    projectSlug: args.projectSlug,
    character: sidecar.character,
    items: [item],
    jokeTypes: [jokeType],
    showBrief: sidecar.show_brief,
    tone: sidecar.tone,
  });
  if (!segment) throw new Error("Model did not return a joke for the segment");

  const next: ClipShowPlanSidecar = {
    ...sidecar,
    segments: sidecar.segments.map((s, i) => (i === args.segmentIndex ? segment : s)),
  };
  await writeClipShowPlan(fs, args.projectSlug, next);
  return next;
}
