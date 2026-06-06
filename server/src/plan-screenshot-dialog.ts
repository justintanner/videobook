import type { AssetManifestFile, VideocityFs } from "vc-engine";
import { createOpenAi, firstContent, imageBase64Part, textPart, withRetry } from "@apicity/openai";
import type { OpenAiContentPart } from "@apicity/openai";
import { extname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { MODEL } from "./tools/_suggest-shared.js";
import type { ScreenshotDialogPlanSidecar } from "./plan-types.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

const ScreenshotDialogSchema = z.object({
  scenes: z.array(z.object({ visual: z.string().min(20) })).min(1),
});

const SCREENSHOT_DIALOG_JSON_SCHEMA = {
  type: "object",
  required: ["scenes"],
  additionalProperties: false,
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        required: ["visual"],
        additionalProperties: false,
        properties: { visual: { type: "string" } },
      },
    },
  },
} as const;

export const SYSTEM_PROMPT_SCREENSHOT_DIALOG = `You produce one image-to-video prompt per screenshot/dialog pair.

INPUTS YOU RECEIVE:
- A list of screenshot assets in order.
- A matching dialog block for each screenshot.
- Image inputs in the same order as the screenshot list.

YOUR JOB:
For each screenshot, return one "visual" paragraph, 50-90 words, that describes a cinematic video starting from that screenshot. Preserve the screenshot's core subject, location, framing, wardrobe, and visual continuity. Add only plausible motion, camera movement, expression, and physical acting that support the exact dialog. The prompt should make the speaker visibly deliver the dialog and include subtle environmental motion. Do not rewrite or omit the dialog; treat it as exact spoken content for downstream audio generation.

OUTPUT: JSON only, matching the provided schema. The "scenes" array MUST have exactly one entry per screenshot/dialog pair, in the same order.`;

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function mimeForFilename(filename: string): string {
  const ext = extname(filename).replace(/^\./, "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

export function durationForDialog(dialog: string): number {
  const wordCount = dialog.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(15, Math.max(4, Math.ceil(wordCount / 2.5)));
}

function buildUserContext(screenshotAssetIds: string[], dialogBlocks: string[]): string {
  const scenes = screenshotAssetIds.map((assetId, i) => [
    `Scene ${i + 1}: @${assetId}`,
    "Dialog:",
    dialogBlocks[i],
  ].join("\n"));
  return [
    `Screenshots and dialog (${screenshotAssetIds.length} total, produce one "visual" per scene in order):`,
    "",
    scenes.join("\n\n"),
    "",
    "Image inputs follow in the same order as the scene list.",
  ].join("\n");
}

function renderMarkdown(sidecar: ScreenshotDialogPlanSidecar): string {
  const header = [
    "# Plan: screenshots + dialog",
    "",
    `**Screenshots:** ${sidecar.screenshot_asset_ids.map((id) => `@${id}`).join(", ")}`,
    `**Scenes:** ${sidecar.scenes.length}`,
    `**Total estimated duration:** ${sidecar.total_duration_s.toFixed(2)}s`,
    `**Model:** ${sidecar.model}`,
    "",
    "Each scene starts from its screenshot, uses the exact dialog as spoken content, and generates audio in the video model.",
    "",
    "---",
    "",
  ].join("\n");

  const blocks = sidecar.scenes.map((scene, i) => [
    `## Scene ${i + 1} — @${scene.image_asset_id} (${scene.duration_s}s)`,
    "",
    scene.dialog,
    "",
    scene.visual,
    "",
  ].join("\n"));

  return header + blocks.join("\n");
}

export async function generateScreenshotDialogPlan(
  fs: VideocityFs,
  args: {
    projectSlug: string;
    screenshotAssetIds: string[];
    dialogBlocks: string[];
  },
): Promise<ScreenshotDialogPlanSidecar> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

  const screenshotAssetIds = args.screenshotAssetIds.map((id) => id.replace(/^@/, ""));
  const dialogBlocks = args.dialogBlocks.map((block) => block.trim());
  if (screenshotAssetIds.length === 0) throw new Error("At least one screenshot asset is required");
  if (screenshotAssetIds.length !== dialogBlocks.length) {
    throw new Error(`Expected ${screenshotAssetIds.length} dialog block(s), got ${dialogBlocks.length}`);
  }
  const emptyDialogIndex = dialogBlocks.findIndex((block) => block.length === 0);
  if (emptyDialogIndex >= 0) throw new Error(`Dialog block ${emptyDialogIndex + 1} is empty`);

  const frameParts: OpenAiContentPart[] = [];
  for (const assetId of screenshotAssetIds) {
    if (!assetId.startsWith("img-")) throw new Error(`Screenshot asset must be img-*, got: ${assetId}`);
    const manifest = await fs.getManifest(assetId, args.projectSlug, { includeDotfiles: false });
    if (!manifest.ok) throw new Error(manifest.error.message);
    const imageFile = findImageFile(manifest.value.files);
    if (!imageFile) throw new Error(`No image file found in asset ${assetId}`);
    const read = await fs.readFile(assetId, imageFile.name, args.projectSlug);
    if (!read.ok) throw new Error(read.error.message);
    frameParts.push(imageBase64Part(Buffer.from(read.value).toString("base64"), mimeForFilename(imageFile.name), "low"));
  }

  const userContext = buildUserContext(screenshotAssetIds, dialogBlocks);
  const provider = createOpenAi({ apiKey, timeout: 240_000 });
  const call = withRetry(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

  const result = await call({
    model: MODEL,
    stream: false,
    messages: [
      { role: "system", content: SYSTEM_PROMPT_SCREENSHOT_DIALOG },
      { role: "user", content: [textPart(userContext), ...frameParts] },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "plan_screenshot_dialog",
        schema: SCREENSHOT_DIALOG_JSON_SCHEMA as unknown as Record<string, unknown>,
        strict: true,
      },
    },
    temperature: 0.5,
    max_completion_tokens: 8192,
  });

  let visuals: Array<{ visual: string }>;
  try {
    const raw = JSON.parse(firstContent(result));
    visuals = ScreenshotDialogSchema.parse(raw).scenes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Model output failed schema validation: ${msg}`);
  }

  if (visuals.length !== screenshotAssetIds.length) {
    throw new Error(`Model returned ${visuals.length} scenes for ${screenshotAssetIds.length} screenshot(s); expected one-to-one`);
  }

  const scenes = screenshotAssetIds.map((assetId, i) => ({
    image_asset_id: assetId,
    dialog: dialogBlocks[i],
    visual: visuals[i].visual,
    duration_s: durationForDialog(dialogBlocks[i]),
    video: null,
  }));
  const sidecar: ScreenshotDialogPlanSidecar = {
    formula: "screenshot_dialog",
    scenes,
    screenshot_asset_ids: screenshotAssetIds,
    total_duration_s: scenes.reduce((acc, scene) => acc + scene.duration_s, 0),
    model: MODEL,
    analysis_prompt: SYSTEM_PROMPT_SCREENSHOT_DIALOG,
    user_context: userContext,
  };

  const projectResult = await fs.getProject(args.projectSlug);
  if (!projectResult.ok) throw new Error(projectResult.error.message);
  await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

  const writeMd = await fs.writeFile("plan", "index.md", renderMarkdown(sidecar), args.projectSlug);
  if (!writeMd.ok) throw new Error(`Failed to write index.md: ${writeMd.error.message}`);

  const writeJson = await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), args.projectSlug);
  if (!writeJson.ok) throw new Error(`Failed to write .plan.json: ${writeJson.error.message}`);

  return sidecar;
}
