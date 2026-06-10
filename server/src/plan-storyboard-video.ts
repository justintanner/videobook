import type { AssetManifestFile, VideocityFs } from "videocity-engine";
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
const MAX_SOURCE_IMAGES = 15;
type StoryboardVideoModel = StoryboardVideoPlanSidecar["video_model"];

function isStoryboardVideoModel(value: unknown): value is StoryboardVideoModel {
  return value === "generate_seedance2_video" || value === "generate_seedance2_fast_video";
}

function normalizeStoryboardVideoModel(value: unknown): StoryboardVideoModel {
  return value === "generate_seedance2_fast_video" ? "generate_seedance2_fast_video" : "generate_seedance2_video";
}

function buildDefaultVideoPrompt(loopVideo: boolean, sourceImageCount = 1): string {
  const additionalSourceLine = sourceImageCount > 1
    ? `Use [Image 3]${sourceImageCount > 2 ? ` through [Image ${sourceImageCount + 1}]` : ""} as additional source image references for secondary identity, wardrobe, object, setting, texture, lighting, mood, and style details.`
    : "";
  const referenceOrderLine = sourceImageCount > 1
    ? `Reference images are sent in this exact order: [Image 1] is the generated storyboard sheet, [Image 2] is the primary source image, and [Image 3]${sourceImageCount > 2 ? ` through [Image ${sourceImageCount + 1}] are additional source images` : " is an additional source image"}.`
    : "Reference images are sent in this exact order: [Image 1] is the generated storyboard sheet, [Image 2] is the primary source image.";
  return `Use [Image 1] as the authoritative director-approved storyboard blueprint for the sequence. Treat every storyboard panel as a consecutive shot within a single cinematic sequence. Follow panel order exactly and do not invent alternative coverage. Do not render the storyboard sheet itself; recreate the filmed sequence implied by the storyboard panels.
Use [Image 2] as the primary source image and primary visual reference for subject identity, wardrobe, proportions, setting, mood, color palette, and material details.
${additionalSourceLine}

${referenceOrderLine}

Preserve the storyboard's panel order, shot scale, camera direction, staging, action choreography, continuity notes, and emotional arc. Preserve the source images' visible subjects, environments, wardrobe, props, lighting character, and overall aesthetic. If the storyboard contains director-strip text, use it as timing and rhythm guidance; if source images conflict with the storyboard, keep the source images authoritative for identity and visual design while keeping the storyboard authoritative for sequence structure.

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

function providerSafeStoryboardBrief(value: string): { text: string; adapted: boolean } {
  let text = normalizeBrief(value);
  if (!text) return { text, adapted: false };

  const original = text;
  text = text
    .replace(/\bfake\s+(?:eff?iel|eiffel)\s+towers\b/gi, "counterfeit Eiffel Tower souvenirs")
    .replace(/\bfake\s+trinkets\b/gi, "counterfeit souvenirs")
    .replace(/\bscammer\b/gi, "unauthorized souvenir seller")
    .replace(/\bexposes\s+him\s+by\s+saying\s+["']it's a scam["']/gi, "clearly warns that the sale is counterfeit")
    .replace(/["']it's a scam["']/gi, "a clear warning about counterfeit souvenirs")
    .replace(/["']pack it up and move along["']/gi, "a calm request to move along")
    .replace(/\bgo back to where you came from\b/gi, "move along")
    .replace(/["']move along["']/gi, "move along");

  if (/go\s+back\s+to\s+where\s+you\s+came\s+from/i.test(original)) {
    text = text.replace(/\bthen\s+tells\s+the\s+unauthorized souvenir seller\s+to\s+move along\b/gi, "then asks the seller to move along");
  }

  return { text, adapted: text !== original };
}

function directionBlock(storyboardBrief: string, loopVideo: boolean): string {
  const safeBrief = providerSafeStoryboardBrief(storyboardBrief);
  return [
    "[STORY DIRECTION]",
    safeBrief.text
      ? `${safeBrief.adapted ? "User direction, adapted for visual storytelling" : "User direction"}: ${safeBrief.text}`
      : "User direction: derive the sequence subject and action from the source image analysis.",
    ...(safeBrief.adapted
      ? ["Safety adaptation: keep confrontation visual and non-hateful; do not render exact hostile quoted dialog or origin-based insults."]
      : []),
    loopVideo
      ? "Loop behavior: design the final panel to visually match the opening panel so the generated video can cut back to the start cleanly."
      : "Loop behavior: this does not need to loop; end on a satisfying final beat without forcing a match back to the opening frame.",
  ].join("\n");
}

function isDefaultVideoPrompt(prompt: string | undefined): boolean {
  if (!prompt) return false;
  return (
    prompt.startsWith("Use [Image 1] as the authoritative director-approved storyboard blueprint")
    || prompt.startsWith("Use [Image 1] as the only visual reference image. [Image 1] is a single concatenated reference sheet")
  ) && prompt.includes("[LOOP REQUIREMENT]");
}

function normalizeSourceImageIds(args: {
  sourceImageAssetId?: string;
  sourceImageAssetIds?: string[];
}): string[] {
  const input = [
    ...(args.sourceImageAssetId ? [args.sourceImageAssetId] : []),
    ...(args.sourceImageAssetIds ?? []),
  ];
  const ids: string[] = [];
  for (const value of input) {
    const id = value.replace(/^@/, "").trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  if (ids.length === 0) throw new Error("At least one source image is required");
  if (ids.length > MAX_SOURCE_IMAGES) {
    throw new Error(`At most ${MAX_SOURCE_IMAGES} source images are supported`);
  }
  return ids;
}

function sourceImageIdsForPlan(plan: StoryboardVideoPlanSidecar | null): string[] {
  if (!plan) return [];
  return normalizeSourceImageIds({
    sourceImageAssetId: plan.source_image_asset_id,
    sourceImageAssetIds: plan.source_image_asset_ids,
  });
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function buildStoryboardPromptFromAnalysis(
  analysis: StoryboardVideoSourceAnalysis,
  storyboardBrief = "",
  loopVideo = false,
): string {
  return `Create a 16:9 image.

[SOURCE]
Use the attached image and this analysis as the creative source of truth. Preserve visible subject identity, proportions, wardrobe, location logic, lighting, mood, color palette, and camera language.
${analysisBlock(analysis)}

${directionBlock(storyboardBrief, loopVideo)}

[STORYBOARD SHEET]
Make a compact cinematic storyboard sheet, not a photoreal still.
Create a small designed masthead with an uppercase title and a short meta line.
Draw 12 panels in a 3x4 grid, derived from the source image and story direction.
P01 is the hook close-up, P02 is the geography master, P03-P10 are connected action beats, P11 is the payoff setup, and P12 is ${loopVideo ? "a visual match back to P01 for a clean loop" : "a clean final beat"}.
Every panel must be a visual-only low-detail monochrome rough sketch on off-white paper with light-gray pencil lines. Keep panel numbers, lens tags, and beat names in header strips outside the panel art. Do not put dialogue, captions, subtitles, arrows, UI, logos, watermarks, or technical overlays inside panels.
At the bottom, add a compact director strip with short one-to-three-word chips for BEAT, CAMERA, ACTION, RHYTHM, ESCALATION, STATE, and STYLE.
The storyboard must look custom-built from the source image analysis, not from a fixed template.

[SEQUENCE]
Grid: compact 12-panel cinematic storyboard sheet; panel artwork stays monochrome rough sketch while the director strip shapes a custom image-derived ${loopVideo ? "loopable" : "non-loop"} sequence.`;
}

function renderMarkdown(sidecar: StoryboardVideoPlanSidecar): string {
  const sourceImageAssetIds = sourceImageIdsForPlan(sidecar);
  return [
    "# Plan: image -> storyboard -> video",
    "",
    `**Primary source image:** @${sidecar.source_image_asset_id}`,
    `**Source images:** ${sourceImageAssetIds.map((id) => `@${id}`).join(", ")}`,
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
    sourceImageAssetId?: string;
    sourceImageAssetIds?: string[];
    storyboardBrief?: string;
    loopVideo?: boolean;
    storyboardPrompt?: string;
    videoPrompt?: string;
    videoModel?: unknown;
    durationS?: number;
    rebuildPrompts?: boolean;
  },
): Promise<StoryboardVideoPlanSidecar> {
  const sourceImageAssetIds = normalizeSourceImageIds({
    sourceImageAssetId: args.sourceImageAssetId,
    sourceImageAssetIds: args.sourceImageAssetIds,
  });
  const sourceImageAssetId = sourceImageAssetIds[0];
  if (!sourceImageAssetId) throw new Error("At least one source image is required");
  for (const [index, assetId] of sourceImageAssetIds.entries()) {
    await resolveImageFile(fs, args.projectSlug, assetId, `source_image_asset_ids[${index}]`);
  }

  let existing: StoryboardVideoPlanSidecar | null = null;
  try {
    existing = await readStoryboardVideoPlan(fs, args.projectSlug);
  } catch {
    existing = null;
  }

  const sameSource = sameStringArray(sourceImageIdsForPlan(existing), sourceImageAssetIds);
  const storyboardBrief = normalizeBrief(args.storyboardBrief ?? (sameSource ? existing?.storyboard_brief : undefined));
  const loopVideo = args.loopVideo ?? (sameSource ? existing?.loop_video ?? false : false);
  const rebuildPrompts = args.rebuildPrompts === true;
  const directionChanged = sameSource && existing
    ? (existing.storyboard_brief ?? "") !== storyboardBrief || (existing.loop_video ?? false) !== loopVideo
    : false;
  const explicitStoryboardPrompt = args.storyboardPrompt?.trim();
  const existingStoryboardPrompt = sameSource && !directionChanged && !rebuildPrompts ? existing?.storyboard_prompt : undefined;
  const needsGeneratedStoryboardPrompt = !explicitStoryboardPrompt && !existingStoryboardPrompt;
  const sourceImageAnalysis = needsGeneratedStoryboardPrompt
    ? await analyzeSourceImage(fs, args.projectSlug, sourceImageAssetId)
    : sameSource
      ? existing?.source_image_analysis ?? await readCachedSourceAnalysis(fs, args.projectSlug, sourceImageAssetId)
      : await readCachedSourceAnalysis(fs, args.projectSlug, sourceImageAssetId);

  const durationS = Math.min(15, Math.max(4, args.durationS ?? existing?.duration_s ?? 15));
  const existingVideoModel = existing?.video_model;
  const existingVideoModelSupported = isStoryboardVideoModel(existingVideoModel);
  const nextVideoModel = normalizeStoryboardVideoModel(args.videoModel ?? existingVideoModel);
  const videoModelChanged = existing
    ? !existingVideoModelSupported || nextVideoModel !== existingVideoModel
    : false;
  const explicitVideoPrompt = args.videoPrompt?.trim();
  const existingVideoPrompt = sameSource && !directionChanged && !rebuildPrompts && !videoModelChanged && !isDefaultVideoPrompt(existing?.video_prompt)
    ? existing?.video_prompt
    : undefined;
  const nextStoryboardPrompt = explicitStoryboardPrompt || existingStoryboardPrompt || buildStoryboardPromptFromAnalysis(sourceImageAnalysis!, storyboardBrief, loopVideo);
  const nextVideoPrompt = explicitVideoPrompt || existingVideoPrompt || buildDefaultVideoPrompt(loopVideo, sourceImageAssetIds.length);
  const storyboardPromptChanged = existing ? (existing.storyboard_prompt ?? "") !== nextStoryboardPrompt : true;
  const videoPromptChanged = existing ? (existing.video_prompt ?? "") !== nextVideoPrompt : true;
  const keepStoryboardAsset = sameSource && !directionChanged && !rebuildPrompts && !storyboardPromptChanged;
  const keepVideoAsset = keepStoryboardAsset
    && !videoPromptChanged
    && !videoModelChanged
    && durationS === existing?.duration_s;
  const sidecar: StoryboardVideoPlanSidecar = {
    formula: "storyboard_video",
    source_image_asset_id: sourceImageAssetId,
    source_image_asset_ids: sourceImageAssetIds,
    source_image_analysis: sourceImageAnalysis,
    storyboard_brief: storyboardBrief,
    loop_video: loopVideo,
    storyboard_prompt: nextStoryboardPrompt,
    video_prompt: nextVideoPrompt,
    storyboard_asset_id: keepStoryboardAsset ? existing?.storyboard_asset_id ?? null : null,
    video_asset_id: keepVideoAsset ? existing?.video_asset_id ?? null : null,
    storyboard_model: "generate_gpt_image",
    video_model: nextVideoModel,
    duration_s: durationS,
    aspect_ratio: "16:9",
    resolution: "720p",
    total_duration_s: durationS,
  };

  await writeStoryboardVideoPlan(fs, args.projectSlug, sidecar);
  return sidecar;
}
