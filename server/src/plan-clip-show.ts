import type { VideocityFs } from "videocity-engine";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAi, firstContent, imageBase64Part, textPart, withRetry } from "@apicity/openai";
import type { OpenAiContentPart, OpenAiChatRequest, OpenAiChatResponse } from "@apicity/openai";
import { z } from "zod";
import { CHARACTER_METADATA_KEY, type Character } from "./jobs/extract-character.js";
import { findImageFile } from "./tools/_image-inputs.js";
import { mimeForImageFilename } from "./jobs/describe-image.js";
import { slugify } from "./tools/_fal-shared.js";
import { queue } from "./queue.js";
import { DEFAULT_JOKE_TYPE, jokeTypeHint, normalizeJokeType } from "./clip-show-joke-types.js";
import { normalizeTreatment } from "./clip-show-osg-types.js";
import type { ClipShowCharacter, ClipShowOsg, ClipShowPlanSidecar, ClipShowSegment } from "./plan-types.js";

const MODEL = "gpt-5.5";
const IMAGE_MODEL = "generate_nano_banana_pro_fal" as const;
const OSG_ASPECT_RATIO = "16:9";
const MAX_POOL = 12; // max input images dropped into one plan
const MAX_OSGS_PER_JOKE = 12; // bound the run length
const MAX_TOTAL_OSGS = 48; // bound total text-to-image fan-out per plan
const MIN_OSG_MS = 500;
const MAX_OSG_MS = 4000;
const DEFAULT_TONE = "sharp, profane, irreverent, roast-heavy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STYLE_EXAMPLES_PATH = join(__dirname, "guides/joke_style_examples.txt");
const TYPE_PALETTE_PATH = join(__dirname, "guides/joke_types_palette.txt");

type JokeReference = { examples: string; typesPalette: string };

// Read the house-style examples + joke-type palette once, then cache the
// promise. Static reference text; ~2k tokens injected into every generation
// and per-joke regeneration.
let referencePromise: Promise<JokeReference> | null = null;
function loadJokeReference(): Promise<JokeReference> {
  if (!referencePromise) {
    referencePromise = (async () => {
      const [examples, typesPalette] = await Promise.all([
        readFile(STYLE_EXAMPLES_PATH, "utf-8"),
        readFile(TYPE_PALETTE_PATH, "utf-8"),
      ]);
      return { examples: examples.trim(), typesPalette: typesPalette.trim() };
    })();
  }
  return referencePromise;
}

type LoadedImage = { bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" };

// One OSG as returned by the model: either a reused input image
// (source:"input" + input_index) or a new generated graphic
// (source:"generated" + image_prompt). Strict JSON schema can't express a
// discriminated union, so both fields are required+nullable and resolved by
// `source` in normalization.
const GeneratedOsgSchema = z.object({
  source: z.enum(["input", "generated"]),
  input_index: z.number().int().nullable(),
  image_prompt: z.string().nullable(),
  treatment: z.string(),
  beat_text: z.string(),
  caption: z.string().nullable(),
  duration_ms: z.number().int(),
});

const GeneratedJokeSchema = z.object({
  source_image_indexes: z.array(z.number().int()),
  source_summary: z.string().min(1),
  joke: z.string().min(1),
  joke_notes: z.string(),
  osgs: z.array(GeneratedOsgSchema).min(1),
});

const GeneratedPlanSchema = z.object({
  jokes: z.array(GeneratedJokeSchema).min(1),
});

const GENERATED_PLAN_JSON_SCHEMA = {
  type: "object",
  required: ["jokes"],
  additionalProperties: false,
  properties: {
    jokes: {
      type: "array",
      items: {
        type: "object",
        required: ["source_image_indexes", "source_summary", "joke", "joke_notes", "osgs"],
        additionalProperties: false,
        properties: {
          source_image_indexes: { type: "array", items: { type: "integer" } },
          source_summary: { type: "string" },
          joke: { type: "string" },
          joke_notes: { type: "string" },
          osgs: {
            type: "array",
            items: {
              type: "object",
              required: ["source", "input_index", "image_prompt", "treatment", "beat_text", "caption", "duration_ms"],
              additionalProperties: false,
              properties: {
                source: { type: "string", enum: ["input", "generated"] },
                input_index: { type: ["integer", "null"] },
                image_prompt: { type: ["string", "null"] },
                treatment: { type: "string" },
                beat_text: { type: "string" },
                caption: { type: ["string", "null"] },
                duration_ms: { type: "integer" },
              },
            },
          },
        },
      },
    },
  },
} as const;

// Built per call so the house-style examples and joke-type palette (read from
// server/src/guides/ at runtime) can be baked into the system message.
function buildSystemPrompt(reference: JokeReference): string {
  return `You are the comedy writer AND art director for a Last Week Tonight–style news-comedy cold open. One recurring host delivers the jokes as a voiceover while a rapid-fire run of on-screen graphics (OSGs) illustrates each joke.

You receive a POOL of input images (provided via vision), each with an index. Your job:

1. GROUP the pool into JOKES. A single joke is one comedic premise the host reads aloud — setup, escalation, payoff. One joke may pull in SEVERAL input images, and may also call for NEW graphics you invent. Some images may stand alone as a one-image joke; related images should be grouped together.

2. For each joke, write the spoken line(s) AND lay out an ORDERED RUN of OSGs that fire across the line — fast cuts, one idea per card, building from setup to a hard visual payoff.

Reference example of ONE joke = a 7-OSG run (~13s): a "sinkhole of misery" bit — (1) a map locating the place, (2) a grim cityscape, (3) a Wallace & Gromit still for an absurd aside, (4) a George Orwell portrait for the dystopia turn, (5) a real-looking newspaper headline card, (6) a fake movie-poster payoff, (7) a title-card button. Match THIS density and setup→payoff shape; invent fresh content for the actual images.

For each JOKE return:
- source_image_indexes: the pool indexes this joke uses (may be empty if the whole run is newly generated graphics).
- source_summary: one short sentence describing what these inputs are.
- joke: the spoken line(s) for ElevenLabs text-to-speech — plain spoken words only: no stage directions, no emoji, no markdown, no quotation marks. One clear premise, escalation, and payoff. Keep it tight enough to read across the run.
- joke_notes: a one-line note on the comedic angle. Start it with the joke type, e.g. "Type: Visual roast — ...".
- osgs: the ordered run (most jokes are 4–8 cards; don't pad). Each OSG is EITHER:
    * a reused INPUT image — set "source":"input" and "input_index" to one of this joke's pool indexes (and "image_prompt": null), OR
    * a NEW generated graphic — set "source":"generated" and write "image_prompt": a vivid, self-contained 16:9 text-to-image prompt in the style implied by the treatment (and "input_index": null).
  Every OSG also has:
    * treatment: one of photo | cityscape | map | headline | fake_poster | title_card | caption | portrait
    * beat_text: the exact word or phrase in the joke this card lands on
    * caption: on-screen overlay text, or null
    * duration_ms: how long it holds — rapid-fire cards are short (700–1500), a payoff can hold longer (1500–3000)

HOUSE STYLE — match this voice and rhythm:
The host is irreverent, profane, sexually frank, and roast-forward, with absurd escalations and a hard punch. Be specific and go for the laugh; don't soften it. The lines below are the target voice, energy, and structure — match them. Do NOT reuse these specific people, topics, or wording; write fresh material aimed at the actual images.

${reference.examples}

JOKE TYPES — palette:
Pick whichever type lands best, then name it at the start of joke_notes. Draw from:
${reference.typesPalette}

The one floor: roast targets, situations, and contradictions — never punch at protected traits with slurs, and never sexualize anyone who appears to be a minor. Everything else is fair game.

Return JSON only.`;
}

function stripAt(value: string): string {
  return value.replace(/^@/, "").trim();
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
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

// Normalize the dropped image pool: img-* only, deduped, in order, bounded.
function normalizePool(raw: string[]): string[] {
  const pool = uniqueInOrder(raw.map(stripAt).filter((id) => id.startsWith("img-")));
  if (pool.length === 0) throw new Error("At least one img-* image is required");
  if (pool.length > MAX_POOL) throw new Error(`At most ${MAX_POOL} images are supported per Clip Show plan`);
  return pool;
}

// Load every distinct pool image's bytes for vision.
async function loadImagePool(
  fs: VideocityFs,
  projectSlug: string,
  pool: string[],
): Promise<Map<string, LoadedImage>> {
  const images = new Map<string, LoadedImage>();
  for (const id of pool) {
    if (!images.has(id)) {
      const loaded = await loadImageBytes(fs, projectSlug, id);
      if (loaded) images.set(id, loaded);
    }
  }
  return images;
}

type GenerationMode = "pool" | "single";

function buildUserContent(args: {
  character: ClipShowCharacter;
  pool: string[];
  images: Map<string, LoadedImage>;
  mode: GenerationMode;
  jokeType: string;
  showBrief: string;
  tone: string;
  textSeed: string;
}): OpenAiContentPart[] {
  const { character, pool, images, mode, jokeType, showBrief, tone, textSeed } = args;
  const hint = jokeTypeHint(jokeType);
  const header = [
    "Write a Last Week Tonight–style news-comedy cold open.",
    "",
    `Host: ${character.name} (@${character.asset_id})`,
    `Host description: ${character.description || "n/a"}`,
    ...(showBrief ? [`Show brief: ${showBrief}`] : []),
    `Tone: ${tone}`,
    ...(hint ? [`Comedic style for ${mode === "single" ? "this joke" : "the jokes"}: ${hint}`] : []),
    "",
    mode === "single"
      ? pool.length > 0
        ? `Treat ALL ${pool.length} image(s) below as ONE joke. Return exactly one joke whose OSG run uses these images (by index) plus any new generated graphics you invent.`
        : "Rewrite the joke described below as ONE joke. There are no input images, so build the OSG run entirely from new generated graphics."
      : `Here is the input image POOL (${pool.length} image(s)), each with an index. Group them into jokes and lay out each joke's OSG run.`,
    ...(textSeed ? ["", `Subject to keep: ${textSeed}`] : []),
    ...(pool.length > 0 ? ["", "Images:"] : []),
  ].join("\n");

  const parts: OpenAiContentPart[] = [textPart(header)];
  pool.forEach((id, index) => {
    const img = images.get(id);
    parts.push(textPart(`Image index ${index} (@${id})${img ? " — image follows:" : " — (image unavailable; infer from the id)"}`));
    if (img) parts.push(imageBase64Part(img.bytes.toString("base64"), img.mime, "low"));
  });
  return parts;
}

function clampDuration(ms: number): number {
  if (!Number.isFinite(ms)) return 1500;
  return Math.min(MAX_OSG_MS, Math.max(MIN_OSG_MS, Math.round(ms)));
}

// Resolve one model OSG to a persisted ClipShowOsg, or null to drop it.
// Generated OSGs keep image_asset_id:null here — it's filled by the image
// pipeline (materializeGeneratedOsgs).
function normalizeOsg(raw: z.infer<typeof GeneratedOsgSchema>, pool: string[]): ClipShowOsg | null {
  const treatment = normalizeTreatment(raw.treatment);
  const beat_text = raw.beat_text.trim();
  const caption = raw.caption && raw.caption.trim() ? raw.caption.trim() : null;
  const duration_ms = clampDuration(raw.duration_ms);
  if (raw.source === "input") {
    const idx = raw.input_index;
    if (idx === null || !Number.isInteger(idx) || idx < 0 || idx >= pool.length) return null;
    return { source: "upload", image_asset_id: pool[idx], image_prompt: null, treatment, beat_text, caption, duration_ms };
  }
  const prompt = raw.image_prompt?.trim();
  if (!prompt) return null;
  return { source: "generated", image_asset_id: null, image_prompt: prompt, treatment, beat_text, caption, duration_ms };
}

// Resolve model jokes to persisted segments. Generated OSGs are left
// unmaterialized (image_asset_id:null) for the image pipeline. Bounds the run
// length per joke and the total OSG fan-out per plan.
function normalizeGeneratedJokes(
  generated: z.infer<typeof GeneratedPlanSchema>["jokes"],
  pool: string[],
  jokeType: string,
): ClipShowSegment[] {
  const segments: ClipShowSegment[] = [];
  let totalOsgs = 0;
  for (const joke of generated) {
    if (totalOsgs >= MAX_TOTAL_OSGS) break;
    const sourceIds = uniqueInOrder(
      joke.source_image_indexes
        .filter((i) => Number.isInteger(i) && i >= 0 && i < pool.length)
        .map((i) => pool[i]),
    );
    const osgs: ClipShowOsg[] = [];
    for (const raw of joke.osgs) {
      if (osgs.length >= MAX_OSGS_PER_JOKE || totalOsgs >= MAX_TOTAL_OSGS) break;
      const osg = normalizeOsg(raw, pool);
      if (!osg) continue;
      osgs.push(osg);
      totalOsgs++;
    }
    if (osgs.length === 0) continue;
    const notes = joke.joke_notes.trim();
    segments.push({
      source_image_asset_ids: sourceIds,
      source_summary: joke.source_summary.trim(),
      joke: joke.joke.trim(),
      ...(notes ? { joke_notes: notes } : {}),
      joke_type: jokeType,
      osgs,
      audio_asset_id: null,
    });
  }
  if (segments.length === 0) throw new Error("Model returned no usable jokes");
  return segments;
}

// Create an img-* asset for a generated OSG and enqueue its text-to-image job.
// Returns the asset id (still generating) or null if the asset couldn't be
// created. The client's sync loop downloads + readies the image; status is
// derived from the asset store, never written back into the plan.
async function createAndEnqueueOsgImage(
  fs: VideocityFs,
  projectSlug: string,
  prompt: string,
  seq: number,
): Promise<string | null> {
  const base = slugify(prompt).slice(0, 40) || "osg";
  const created = await fs.createAsset("img", `osg-${base}-${seq}-${Date.now().toString(36)}`, projectSlug);
  if (!created.ok) return null;
  const { assetId, path } = created.value;
  const jobId = `osg-img-${assetId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: IMAGE_MODEL,
    imgAssetId: assetId,
    imgAssetDir: path,
    projectSlug,
    prompt,
    aspect_ratio: OSG_ASPECT_RATIO,
  } as unknown as Record<string, unknown>);
  return assetId;
}

// Walk segments and turn each unmaterialized generated OSG into a real img-*
// asset + enqueued job. A failed createAsset leaves image_asset_id:null (the
// UI offers a regenerate slot); it never fails the whole plan.
async function materializeGeneratedOsgs(
  fs: VideocityFs,
  projectSlug: string,
  segments: ClipShowSegment[],
): Promise<ClipShowSegment[]> {
  let seq = 0;
  const out: ClipShowSegment[] = [];
  for (const segment of segments) {
    const osgs: ClipShowOsg[] = [];
    for (const osg of segment.osgs) {
      if (osg.source === "generated" && osg.image_asset_id === null && osg.image_prompt) {
        const assetId = await createAndEnqueueOsgImage(fs, projectSlug, osg.image_prompt, seq++);
        osgs.push({ ...osg, image_asset_id: assetId });
      } else {
        osgs.push(osg);
      }
    }
    out.push({ ...segment, osgs });
  }
  return out;
}

// Run GPT-5.5 over a pool of images and return normalized (unmaterialized)
// segments. Shared by full-plan generation ("pool") and single-joke
// regeneration ("single").
async function generateJokes(args: {
  fs: VideocityFs;
  projectSlug: string;
  character: ClipShowCharacter;
  pool: string[];
  mode: GenerationMode;
  jokeType: string;
  showBrief: string;
  tone: string;
  textSeed?: string;
}): Promise<ClipShowSegment[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

  const images = await loadImagePool(args.fs, args.projectSlug, args.pool);
  const reference = await loadJokeReference();
  const provider = createOpenAi({ apiKey, timeout: 240_000 });
  const call = withRetry<OpenAiChatRequest, OpenAiChatResponse>(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

  const result = await call({
    model: MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt(reference) },
      {
        role: "user",
        content: buildUserContent({
          character: args.character,
          pool: args.pool,
          images,
          mode: args.mode,
          jokeType: args.jokeType,
          showBrief: args.showBrief,
          tone: args.tone,
          textSeed: args.textSeed ?? "",
        }),
      },
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
  const jokes = args.mode === "single" ? parsed.jokes.slice(0, 1) : parsed.jokes;
  return normalizeGeneratedJokes(jokes, args.pool, args.jokeType);
}

function renderMarkdown(sidecar: ClipShowPlanSidecar): string {
  return [
    "# Plan: Clip Show (read-through)",
    "",
    `**Host:** @${sidecar.character.asset_id} (${sidecar.character.name})`,
    `**Voice:** ${sidecar.character.elevenlabs_voice_id}`,
    `**Models:** ${sidecar.model} · images ${sidecar.image_model} · audio ${sidecar.audio_model}`,
    `**Tone:** ${sidecar.tone}`,
    "",
    ...(sidecar.show_brief ? ["## Show Brief", "", sidecar.show_brief, ""] : []),
    ...sidecar.segments.flatMap((segment, index) => {
      const style = segment.joke_type && segment.joke_type !== DEFAULT_JOKE_TYPE ? ` (${segment.joke_type})` : "";
      const sources = segment.source_image_asset_ids.length
        ? segment.source_image_asset_ids.map((id) => `@${id}`).join(", ")
        : "—";
      return [
        `## Joke ${index + 1}${style}`,
        "",
        `**Sources:** ${sources}`,
        `**Audio:** ${segment.audio_asset_id ? `@${segment.audio_asset_id}` : "not generated"}`,
        "",
        segment.source_summary,
        "",
        "### Joke",
        "",
        segment.joke,
        ...(segment.joke_notes ? ["", `_${segment.joke_notes}_`] : []),
        "",
        "### OSG run",
        "",
        ...segment.osgs.map((osg, i) => {
          const img = osg.image_asset_id ? `@${osg.image_asset_id}` : "(no image)";
          const cap = osg.caption ? ` — “${osg.caption}”` : "";
          return `${i + 1}. **${osg.treatment}** ${img} (${osg.source}, ${osg.duration_ms}ms) — ${osg.beat_text}${cap}`;
        }),
        "",
      ];
    }),
  ].join("\n");
}

// Write one plan file only when its content actually changed. The engine commits
// each write scoped to that file's path, and a scoped `git commit -- <path>` with
// no diff exits non-zero (empty stderr, "nothing to commit") whenever the repo is
// otherwise dirty — which it almost always is, since the engine's state DB is
// modified by routine asset work. Skipping no-op writes lets idempotent plan
// edits (e.g. "set joke" with unchanged text before generating a voiceover)
// succeed instead of throwing a bare "Failed to commit file write".
async function writePlanFileIfChanged(
  fs: VideocityFs,
  projectSlug: string,
  fileName: string,
  content: string,
): Promise<void> {
  const existing = await fs.readFile("plan", fileName, projectSlug);
  if (existing.ok && Buffer.from(existing.value).toString("utf-8") === content) return;
  const written = await fs.writeFile("plan", fileName, content, projectSlug);
  if (!written.ok) throw new Error(`Failed to write ${fileName}: ${written.error.message}`);
}

export async function writeClipShowPlan(
  fs: VideocityFs,
  projectSlug: string,
  sidecar: ClipShowPlanSidecar,
): Promise<void> {
  const projectResult = await fs.getProject(projectSlug);
  if (!projectResult.ok) throw new Error(projectResult.error.message);
  await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

  await writePlanFileIfChanged(fs, projectSlug, "index.md", renderMarkdown(sidecar));
  await writePlanFileIfChanged(fs, projectSlug, ".plan.json", JSON.stringify(sidecar, null, 2));
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
    imageAssetIds: string[];
    showBrief?: string;
    tone?: string;
  },
): Promise<ClipShowPlanSidecar> {
  const pool = normalizePool(args.imageAssetIds);
  const character = await loadClipShowCharacter(fs, args.projectSlug, args.characterAssetId);
  const showBrief = args.showBrief?.trim() ?? "";
  const tone = args.tone?.trim() || DEFAULT_TONE;

  // Generated OSGs are left unmaterialized (image_asset_id:null) — text-to-image
  // is opt-in. The user fills them via the plan's "Generate images" button
  // (generate_clip_show_images) or per-OSG regenerate, not automatically.
  const segments = await generateJokes({
    fs,
    projectSlug: args.projectSlug,
    character,
    pool,
    mode: "pool",
    jokeType: DEFAULT_JOKE_TYPE,
    showBrief,
    tone,
  });

  const sidecar: ClipShowPlanSidecar = {
    formula: "clip_show",
    character,
    show_brief: showBrief,
    tone,
    model: MODEL,
    image_model: IMAGE_MODEL,
    audio_model: "elevenlabs",
    segments,
  };
  await writeClipShowPlan(fs, args.projectSlug, sidecar);
  return sidecar;
}

// Rewrite one joke (and its whole OSG run) via GPT-5.5 — optionally in a
// different joke type and/or with an added/swapped source image. The joke's
// image pool is its existing source images plus any reused-upload OSGs; with no
// images we fall back to a text seed. Materializes fresh generated OSGs and
// clears the now-stale voiceover. Returns the full updated sidecar.
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
  if (!Array.isArray(existing.osgs)) {
    throw new Error("This Clip Show plan uses the old format — regenerate it from /templates before editing.");
  }

  const pool = uniqueInOrder([
    ...existing.source_image_asset_ids,
    ...existing.osgs.filter((o) => o.source === "upload" && o.image_asset_id).map((o) => o.image_asset_id as string),
  ]);
  if (args.newImageAssetId) {
    const id = stripAt(args.newImageAssetId);
    if (!id.startsWith("img-")) throw new Error(`image_asset_id must be an img-* asset, got: ${id}`);
    if (!pool.includes(id)) pool.push(id);
  }
  if (pool.length > MAX_POOL) pool.length = MAX_POOL;

  const jokeType = normalizeJokeType(args.jokeType ?? existing.joke_type);
  const textSeed = pool.length === 0 ? `${existing.source_summary} — ${existing.joke}`.trim() : "";

  // Like full-plan generation, the rewritten OSG run is left unmaterialized;
  // the user opts into images via the plan's "Generate images" button.
  const [segment] = await generateJokes({
    fs,
    projectSlug: args.projectSlug,
    character: sidecar.character,
    pool,
    mode: "single",
    jokeType,
    showBrief: sidecar.show_brief,
    tone: sidecar.tone,
    textSeed,
  });
  if (!segment) throw new Error("Model did not return a joke for the segment");

  const next: ClipShowPlanSidecar = {
    ...sidecar,
    segments: sidecar.segments.map((s, i) => (i === args.segmentIndex ? segment : s)),
  };
  await writeClipShowPlan(fs, args.projectSlug, next);
  return next;
}

// Opt-in image generation for the whole plan: materialize every generated OSG
// that still lacks an image (source:"generated", image_asset_id:null, has a
// prompt) by creating its img-* asset and enqueuing the text-to-image job.
// Idempotent — already-materialized OSGs and uploads are untouched — and a plain
// read-modify-write (no GPT). Returns the updated sidecar; images fill in via
// the normal sync loop.
export async function generateClipShowImages(
  fs: VideocityFs,
  args: { projectSlug: string },
): Promise<ClipShowPlanSidecar> {
  const sidecar = await readClipShowPlan(fs, args.projectSlug);
  const segments = await materializeGeneratedOsgs(fs, args.projectSlug, sidecar.segments);
  const next: ClipShowPlanSidecar = { ...sidecar, segments };
  await writeClipShowPlan(fs, args.projectSlug, next);
  return next;
}

// Generate a fresh image for one OSG: create an img-* asset, enqueue the
// text-to-image job, and patch that OSG's image_asset_id/prompt/treatment in
// place. A plain read-modify-write — no GPT. Returns the updated sidecar.
export async function regenerateClipShowOsg(
  fs: VideocityFs,
  args: {
    projectSlug: string;
    segmentIndex: number;
    osgIndex: number;
    imagePrompt?: string | null;
    treatment?: string | null;
  },
): Promise<ClipShowPlanSidecar> {
  const sidecar = await readClipShowPlan(fs, args.projectSlug);
  const segment = sidecar.segments[args.segmentIndex];
  if (!segment || !Array.isArray(segment.osgs)) throw new Error(`Clip Show joke ${args.segmentIndex} not found`);
  const osg = segment.osgs[args.osgIndex];
  if (!osg) throw new Error(`Clip Show OSG ${args.osgIndex} not found`);

  const prompt = (args.imagePrompt?.trim() || osg.image_prompt?.trim() || "").trim();
  if (!prompt) throw new Error("This OSG has no image prompt to regenerate from — supply image_prompt or swap an upload instead.");
  const treatment = args.treatment ? normalizeTreatment(args.treatment) : osg.treatment;

  const assetId = await createAndEnqueueOsgImage(fs, args.projectSlug, prompt, args.osgIndex);
  const nextOsg: ClipShowOsg = { ...osg, source: "generated", image_asset_id: assetId, image_prompt: prompt, treatment };

  const next: ClipShowPlanSidecar = {
    ...sidecar,
    segments: sidecar.segments.map((s, i) =>
      i === args.segmentIndex ? { ...s, osgs: s.osgs.map((o, j) => (j === args.osgIndex ? nextOsg : o)) } : s,
    ),
  };
  await writeClipShowPlan(fs, args.projectSlug, next);
  return next;
}
