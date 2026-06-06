import type { AssetManifestFile, VideocityFs } from "vc-engine";
import { extname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  ANALYSIS_FILENAME,
  describeImageBytes,
  mimeForImageFilename,
} from "./jobs/describe-image.js";
import type { DescribeImageResult } from "./jobs/describe-image.js";
import type { StoryboardVideoPlanSidecar, StoryboardVideoSourceAnalysis } from "./plan-types.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function buildDefaultVideoPrompt(loopVideo: boolean): string {
  return `Use [Image 1] as the authoritative director-approved storyboard blueprint for the sequence. Treat every storyboard panel as a consecutive shot within a single cinematic sequence. Follow panel order exactly and do not invent alternative coverage. Do not render the storyboard sheet itself; recreate the filmed sequence implied by the storyboard panels.
Use [Image 2] as the original source image and primary visual reference for subject identity, wardrobe, proportions, setting, mood, color palette, and material details.

Reference images are sent in this exact order: [Image 1] is the generated storyboard sheet, [Image 2] is the original source image.

Preserve the storyboard's panel order, shot scale, camera direction, staging, action choreography, continuity notes, and emotional arc. Preserve the source image's visible subject, environment, wardrobe, props, lighting character, and overall aesthetic. If the storyboard contains director-strip text, use it as timing and rhythm guidance; if the source image conflicts with the storyboard, keep the source image authoritative for identity and visual design while keeping the storyboard authoritative for sequence structure.

Generate one cohesive cinematic video with warm natural motion, clear readable action, plausible physical continuity, and tactile detail. Avoid adding extra characters, logos, captions, subtitles, UI, watermarks, or graphic overlays.

[LOOP REQUIREMENT]
${loopVideo
    ? "Make the final shot visually match the opening shot closely enough to loop cleanly. Preserve subject position, camera angle, motion direction, lighting, and prop state so the end can cut back to the start without a visible jump."
    : "End on a clean final beat. Do not force the final shot to match the opening shot unless the storyboard itself asks for a loop."}`;
}

export const DEFAULT_VIDEO_PROMPT = buildDefaultVideoPrompt(false);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

async function resolveImageFile(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  label: string,
): Promise<AssetManifestFile> {
  if (!assetId.startsWith("img-")) throw new Error(`${label} must be an img-* asset, got: ${assetId}`);
  const manifest = await fs.getManifest(assetId, projectSlug, { includeDotfiles: false });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findImageFile(manifest.value.files);
  if (!file) throw new Error(`No image file found in asset ${assetId}`);
  return file;
}

function normalizeAnalysis(value: unknown): StoryboardVideoSourceAnalysis | null {
  const input = value as Partial<DescribeImageResult> | null;
  if (!input || typeof input.prompt !== "string" || input.prompt.trim().length === 0) return null;
  return {
    prompt: input.prompt.trim(),
    ...(typeof input.shot === "string" && input.shot.trim().length > 0 ? { shot: input.shot.trim() } : {}),
    ...(typeof input.pose === "string" && input.pose.trim().length > 0 ? { pose: input.pose.trim() } : {}),
  };
}

async function readCachedSourceAnalysis(
  fs: VideocityFs,
  projectSlug: string,
  sourceImageAssetId: string,
): Promise<StoryboardVideoSourceAnalysis | null> {
  const read = await fs.readFile(sourceImageAssetId, ANALYSIS_FILENAME, projectSlug);
  if (!read.ok) return null;
  try {
    return normalizeAnalysis(JSON.parse(Buffer.from(read.value).toString("utf-8")));
  } catch {
    return null;
  }
}

async function analyzeSourceImage(
  fs: VideocityFs,
  projectSlug: string,
  sourceImageAssetId: string,
): Promise<StoryboardVideoSourceAnalysis> {
  const cached = await readCachedSourceAnalysis(fs, projectSlug, sourceImageAssetId);
  if (cached) return cached;

  const imageFile = await resolveImageFile(fs, projectSlug, sourceImageAssetId, "source_image_asset_id");
  const read = await fs.readFile(sourceImageAssetId, imageFile.name, projectSlug);
  if (!read.ok) throw new Error(read.error.message);

  const analysis = normalizeAnalysis(await describeImageBytes(
    Buffer.from(read.value),
    mimeForImageFilename(imageFile.name),
  ));
  if (!analysis) throw new Error(`Image analysis for ${sourceImageAssetId} did not include a prompt`);

  await fs.writeFile(sourceImageAssetId, ANALYSIS_FILENAME, JSON.stringify(analysis, null, 2), projectSlug);
  return analysis;
}

function analysisBlock(analysis: StoryboardVideoSourceAnalysis): string {
  return [
    `PROMPT: ${analysis.prompt}`,
    ...(analysis.shot ? [`SHOT: ${analysis.shot}`] : []),
    ...(analysis.pose ? [`POSE: ${analysis.pose}`] : []),
  ].join("\n");
}

function normalizeBrief(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function directionBlock(storyboardBrief: string, loopVideo: boolean): string {
  return [
    "[STORY DIRECTION]",
    storyboardBrief
      ? `User direction: ${storyboardBrief}`
      : "User direction: derive the sequence subject and action from the source image analysis.",
    loopVideo
      ? "Loop behavior: design the final panel to visually match the opening panel so the generated video can cut back to the start cleanly."
      : "Loop behavior: this does not need to loop; end on a satisfying final beat without forcing a match back to the opening frame.",
  ].join("\n");
}

function isDefaultVideoPrompt(prompt: string | undefined): boolean {
  if (!prompt) return false;
  return prompt === buildDefaultVideoPrompt(false) || prompt === buildDefaultVideoPrompt(true);
}

export function buildStoryboardPromptFromAnalysis(
  analysis: StoryboardVideoSourceAnalysis,
  storyboardBrief = "",
  loopVideo = false,
): string {
  return `Create a 16:9 image.

[SOURCE IMAGE ANALYSIS]
Use this image analysis as the creative source of truth. Preserve visible subject identity, proportions, wardrobe, setting, props, lighting, mood, color palette, and camera language from the source image.
${analysisBlock(analysis)}

${directionBlock(storyboardBrief, loopVideo)}

[PROJECT CARD]
Create a compact designed masthead, not a table.
TITLE: Derive a concise uppercase title from the source image analysis.
META LINE: Derive three short slash-separated phrases from the source image's subject, setting, mood, and the story direction.
PRIORITY: Build a readable cinematic storyboard sequence that grows naturally from the source image analysis and the story direction; do not force a prewritten recipe, dance, product, or genre unless the source image supports it.
MICRO BRIEF: Turn the source image into a short, visually coherent video concept with a clear hook, middle action, and ${loopVideo ? "a final beat that loops back into the opening frame" : "a satisfying final beat"}.

[CONTINUITY HEADER]
REFERENCE PRIORITY: The provided source image controls subject identity, body proportions, wardrobe, environment, lighting character, color palette, and visual style. This storyboard controls staging, motion, camera order, continuity, and rhythm.
SEQUENCE ID: derive a short uppercase sequence id from the title.

[SCENE PACKET]
PREMISE: Infer one specific cinematic micro-sequence from the source image analysis. It must feel plausible for the visible subject, location, wardrobe, props, and mood.
LOCATION: Preserve the source image's visible environment and extend it only with plausible adjacent space.
START -> END: Begin from a pose or moment compatible with the source image, then move through 12-16 connected visual beats toward ${loopVideo ? "a final image that can match-cut back to the opening image" : "a clean final image"}.
ACTION CHAIN: Derive actions from visible posture, props, setting, mood, and story direction; keep the chain concrete, filmable, and physically continuous.
PROP / EFFECT STATE: Use only props, textures, atmosphere, and effects implied by the source image unless a simple bridging prop is needed for continuity.
MUST READ: The storyboard must look custom-built from the source image analysis, not from a fixed template.

[CHARACTER SANITIZATION]
Describe only visible or strongly implied traits from the source image analysis. Remove backstory, invisible psychology, and excessive costume detail that cannot appear in a panel.

[IDENTITY CONSISTENCY]
The provided source image controls the primary subject. Do not redesign, age-shift, beautify, duplicate, merge, or add another main subject. Keep wardrobe, hair, silhouette, proportions, and defining visual details consistent across panels.

[STORYBOARD PURITY]
Panel images are visual-only low-detail monochrome light-gray rough sketches. Put panel numbers, beat names, and lens tags in the header strip outside each panel image. No color, labels, arrows, captions, subtitles, logos, watermarks, timing marks, diagrams, UI, ghost poses, duplicate bodies, or technical overlays inside panels.

[MASTER SHOT RULE]
P02 is the geography master that establishes the source image's location, subject placement, main props, and movement path. Use P02 to anchor all later wide, over-shoulder, top-down, close-up, and insert views.

[EMOTIONAL ARC]
Derive the arc from the source image's mood. Show progression through camera distance, expression, posture, hand action, gaze, environmental motion, and texture changes.
${loopVideo ? "For a loop, keep the emotional arc cyclical: hook -> action -> reset/payoff -> visual return to the opening energy." : "For a non-loop, let the emotional arc resolve clearly instead of returning to the opening frame."}

[STYLE LOCKS]
STYLE LOCK: clean monochrome rough-sketch storyboard panels on off-white paper, light-gray gesture lines, simplified shapes, crisp action hierarchy, no rendered panel lighting.
EFFECT LOCK: inside panels, effects and atmosphere are simple monochrome shapes only.
ENVIRONMENT LOCK: preserve the source image's location logic, main background forms, lighting direction, and prop geography across views.

[SPATIAL CONTINUITY LOCK]
Keep the subject and environment in one continuous place. Allowed changes are camera distance, camera height, pose, gaze, prop state, atmospheric state, and final object/action state.

[DIRECTOR STRIP]
Bottom animatic track board aligned to panel columns. Tracks: BEAT LINE, CAMERA PATH, ACTION PATH, RHYTHM TRACK, ESCALATION MAP, STATE TRACK, STYLE TRACK. Use shot chips, thin lines, rhythm blocks, small intensity bars, one-to-three-word labels. No seconds or timestamps.
RHYTHM TRACK format: RHY P##: [hold|slow reveal|build|burst|impact|pause|recover|final hit] / [short block|medium block|long block] / [clean beat|match beat|smash beat|held beat|whip beat].
ESCALATION MAP format: ESC P##: [L1 calm|L2 tension|L3 rise|L4 surge|L5 peak] / [flat|rise|spike|drop|release|unresolved].
PANEL HEADERS: Create 12-16 panels with panel number, lens tag, and beat name in each header strip. Use a mix of close hook, geography master, over-shoulder or back view, hand/prop inserts, action peaks, reaction beat, payoff reveal, and final macro or close detail.
CAMERA + LENS PLAN: Derive camera movement from the source image's shot language and the inferred action chain.
ACTION PATH: List one concrete action per panel, in panel order.
RHYTHM TRACK: Assign rhythm labels per panel based on the action arc.
ESCALATION MAP: Assign escalation labels per panel based on the emotional arc.
STATE TRACK: Track subject, prop, environment, and texture state changes per panel.
STYLE TRACK: Track the dominant visual motif or texture per panel.

[SEQUENCE]
Grid: compact cinematic storyboard sheet; panel artwork stays monochrome rough sketch while the director strip shapes a custom image-derived ${loopVideo ? "loopable" : "non-loop"} sequence.`;
}

function renderMarkdown(sidecar: StoryboardVideoPlanSidecar): string {
  return [
    "# Plan: image -> storyboard -> video",
    "",
    `**Source image:** @${sidecar.source_image_asset_id}`,
    `**Storyboard:** ${sidecar.storyboard_asset_id ? `@${sidecar.storyboard_asset_id}` : "not generated"}`,
    `**Video:** ${sidecar.video_asset_id ? `@${sidecar.video_asset_id}` : "not generated"}`,
    `**Storyboard model:** ${sidecar.storyboard_model}`,
    `**Video model:** ${sidecar.video_model}`,
    `**Duration:** ${sidecar.duration_s}s`,
    `**Aspect:** ${sidecar.aspect_ratio}`,
    `**Loop:** ${sidecar.loop_video ? "yes" : "no"}`,
    "",
    "## Storyboard Direction",
    "",
    sidecar.storyboard_brief || "derive from source image",
    "",
    ...(sidecar.source_image_analysis ? [
      "## Source Image Analysis",
      "",
      analysisBlock(sidecar.source_image_analysis),
      "",
    ] : []),
    "## Storyboard Prompt",
    "",
    sidecar.storyboard_prompt,
    "",
    "## Video Prompt",
    "",
    sidecar.video_prompt,
    "",
  ].join("\n");
}

export async function writeStoryboardVideoPlan(
  fs: VideocityFs,
  projectSlug: string,
  sidecar: StoryboardVideoPlanSidecar,
): Promise<void> {
  const projectResult = await fs.getProject(projectSlug);
  if (!projectResult.ok) throw new Error(projectResult.error.message);
  await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

  const writeMd = await fs.writeFile("plan", "index.md", renderMarkdown(sidecar), projectSlug);
  if (!writeMd.ok) throw new Error(`Failed to write index.md: ${writeMd.error.message}`);

  const writeJson = await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), projectSlug);
  if (!writeJson.ok) throw new Error(`Failed to write .plan.json: ${writeJson.error.message}`);
}

export async function readStoryboardVideoPlan(
  fs: VideocityFs,
  projectSlug: string,
): Promise<StoryboardVideoPlanSidecar> {
  const planRead = await fs.readFile("plan", ".plan.json", projectSlug);
  if (!planRead.ok) throw new Error(`No plan in ${projectSlug}: ${planRead.error.message}`);
  let plan: StoryboardVideoPlanSidecar;
  try {
    plan = JSON.parse(Buffer.from(planRead.value).toString("utf-8")) as StoryboardVideoPlanSidecar;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid .plan.json: ${msg}`);
  }
  if (plan.formula !== "storyboard_video") throw new Error("Active plan is not an image -> storyboard -> video plan");
  return plan;
}

export async function generateStoryboardVideoPlan(
  fs: VideocityFs,
  args: {
    projectSlug: string;
    sourceImageAssetId: string;
    storyboardBrief?: string;
    loopVideo?: boolean;
    storyboardPrompt?: string;
    videoPrompt?: string;
    videoModel?: "generate_seedance2_video" | "generate_seedance2_fast_video";
    durationS?: number;
  },
): Promise<StoryboardVideoPlanSidecar> {
  const sourceImageAssetId = args.sourceImageAssetId.replace(/^@/, "");
  await resolveImageFile(fs, args.projectSlug, sourceImageAssetId, "source_image_asset_id");

  let existing: StoryboardVideoPlanSidecar | null = null;
  try {
    existing = await readStoryboardVideoPlan(fs, args.projectSlug);
  } catch {
    existing = null;
  }

  const sameSource = existing?.source_image_asset_id === sourceImageAssetId;
  const storyboardBrief = normalizeBrief(args.storyboardBrief ?? (sameSource ? existing?.storyboard_brief : undefined));
  const loopVideo = args.loopVideo ?? (sameSource ? existing?.loop_video ?? false : false);
  const directionChanged = sameSource && existing
    ? (existing.storyboard_brief ?? "") !== storyboardBrief || (existing.loop_video ?? false) !== loopVideo
    : false;
  const explicitStoryboardPrompt = args.storyboardPrompt?.trim();
  const existingStoryboardPrompt = sameSource && !directionChanged ? existing?.storyboard_prompt : undefined;
  const needsGeneratedStoryboardPrompt = !explicitStoryboardPrompt && !existingStoryboardPrompt;
  const sourceImageAnalysis = needsGeneratedStoryboardPrompt
    ? await analyzeSourceImage(fs, args.projectSlug, sourceImageAssetId)
    : sameSource
      ? existing?.source_image_analysis ?? await readCachedSourceAnalysis(fs, args.projectSlug, sourceImageAssetId)
      : await readCachedSourceAnalysis(fs, args.projectSlug, sourceImageAssetId);

  const durationS = Math.min(15, Math.max(4, args.durationS ?? existing?.duration_s ?? 15));
  const explicitVideoPrompt = args.videoPrompt?.trim();
  const existingVideoPrompt = sameSource && !directionChanged && !isDefaultVideoPrompt(existing?.video_prompt)
    ? existing?.video_prompt
    : undefined;
  const sidecar: StoryboardVideoPlanSidecar = {
    formula: "storyboard_video",
    source_image_asset_id: sourceImageAssetId,
    source_image_analysis: sourceImageAnalysis,
    storyboard_brief: storyboardBrief,
    loop_video: loopVideo,
    storyboard_prompt: explicitStoryboardPrompt || existingStoryboardPrompt || buildStoryboardPromptFromAnalysis(sourceImageAnalysis!, storyboardBrief, loopVideo),
    video_prompt: explicitVideoPrompt || existingVideoPrompt || buildDefaultVideoPrompt(loopVideo),
    storyboard_asset_id: sameSource ? existing?.storyboard_asset_id ?? null : null,
    video_asset_id: sameSource ? existing?.video_asset_id ?? null : null,
    storyboard_model: "generate_gpt_image",
    video_model: args.videoModel ?? existing?.video_model ?? "generate_seedance2_video",
    duration_s: durationS,
    aspect_ratio: "16:9",
    resolution: "720p",
    total_duration_s: durationS,
  };

  await writeStoryboardVideoPlan(fs, args.projectSlug, sidecar);
  return sidecar;
}
