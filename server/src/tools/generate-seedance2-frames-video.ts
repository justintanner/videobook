import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { Seedance2FastRequestSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

type FrameInput = { assetId: string; filename: string };

async function resolveFrameSlug(
  fs: ClipfirstFs,
  rawSlug: string,
  projectSlug: string,
): Promise<{ ok: true; value: FrameInput } | { ok: false; error: string }> {
  const assetId = rawSlug.replace(/^@/, "");
  if (!assetId.startsWith("img-")) {
    return { ok: false, error: `Frame slugs must be img-* assets, got: ${assetId}` };
  }
  const manifestResult = await fs.getManifest(assetId, projectSlug);
  if (!manifestResult.ok) return { ok: false, error: manifestResult.error.message };
  const imageFile = findImageFile(manifestResult.value.files);
  if (!imageFile) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: imageFile.name } };
}

const seedance2FastInputSchema = Seedance2FastRequestSchema.shape.input.shape;

const generateSeedance2FramesVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description (3-2500 characters)"),
  first_frame_slug: z.string().optional().describe("First frame image asset (e.g., @img-start)"),
  last_frame_slug: z.string().optional().describe("Last frame image asset (e.g., @img-end)"),
  aspect_ratio: z.enum(seedance2FastInputSchema.aspect_ratio.unwrap().options).optional().describe("Output aspect ratio"),
  resolution: z.enum(seedance2FastInputSchema.resolution.unwrap().options).optional().describe("Output resolution"),
  duration: z.string().optional().describe("Video duration in seconds (4-15)"),
  generate_audio: z.boolean().optional().describe("Generate accompanying audio (default true)"),
  return_last_frame: z.boolean().optional().describe("Return the final frame as an image (default false)"),
  web_search: z.boolean().optional().describe("Use web search for enhanced grounding (default false)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedance2FramesVideoSchema>;

export function generateSeedance2FramesVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedance2_frames_video",
    description: "Generate a video using ByteDance Seedance 2.0 Fast with first and/or last frame image control. Creates a new vid- asset and enqueues a background job.",
    schema: generateSeedance2FramesVideoSchema,
    handler: async (args) => {
      const {
        project_slug, prompt, first_frame_slug, last_frame_slug,
        aspect_ratio, resolution, duration,
        generate_audio, return_last_frame, web_search,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!first_frame_slug && !last_frame_slug) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Seedance 2.0 Frames mode requires at least first_frame_slug or last_frame_slug" }],
        };
      }

      let firstFrame: FrameInput | undefined;
      if (first_frame_slug) {
        const result = await resolveFrameSlug(fs, first_frame_slug, project_slug);
        if (!result.ok) return { isError: true as const, content: [{ type: "text" as const, text: result.error }] };
        firstFrame = result.value;
      }

      let lastFrame: FrameInput | undefined;
      if (last_frame_slug) {
        const result = await resolveFrameSlug(fs, last_frame_slug, project_slug);
        if (!result.ok) return { isError: true as const, content: [{ type: "text" as const, text: result.error }] };
        lastFrame = result.value;
      }

      const videoName = `seedance2-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [firstFrame?.assetId, lastFrame?.assetId].filter((v): v is string => v !== undefined);

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "seedance2_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: {
          prompt,
          mode: "frames",
          sourceImageIds,
          ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        },
      });

      const jobId = `seedance2-frames-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedance2_frames_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        sourceImageIds,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        ...(web_search !== undefined ? { web_search } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
