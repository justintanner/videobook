import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { VolcengineVideoToVideoLipSyncModeSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "videocity-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

// modelSlug("kie", "volcengine/video-to-video-lip-sync") would throw —
// @apicity/cost@0.4.2 has no slug registered for the Volcengine model yet, so
// asset/job names use this literal until the cost table catches up.
const SLUG = "volcengine-lipsync";

type RefInput = { assetId: string; filename: string };
type ResolveOk = { ok: true; value: RefInput };
type ResolveErr = { ok: false; error: string };

async function resolveVideoSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return { ok: false, error: `video_slug must be a vid-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `audio_slug must be an aud-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const generateVolcengineLipsyncVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  video_slug: z.string().describe("Source video asset to lip-sync (e.g., @vid-scene)"),
  audio_slug: z.string().describe("Driving audio asset whose speech drives the lips (e.g., @aud-voice)"),
  mode: z.enum(VolcengineVideoToVideoLipSyncModeSchema.options).optional().describe("Quality mode: lite (faster) or basic (default)"),
  separate_vocal: z.boolean().optional().describe("Separate vocals from background audio before sync (default false)"),
  open_scenedet: z.boolean().optional().describe("Enable scene-cut detection (default false)"),
  align_audio: z.boolean().optional().describe("Align audio to the video timeline (default true)"),
  align_audio_reverse: z.boolean().optional().describe("Reverse the audio alignment direction (default false)"),
  templ_start_seconds: z.number().min(0).optional().describe("Template start offset in seconds (default 0)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateVolcengineLipsyncVideoSchema>;

export function generateVolcengineLipsyncVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_volcengine_lipsync_video",
    description: "Lip-sync a source video to driving audio using Volcengine video-to-video lip-sync (kie). Creates a new vid- asset and enqueues a background job.",
    schema: generateVolcengineLipsyncVideoSchema,
    handler: async (args) => {
      const {
        project_slug, video_slug, audio_slug,
        mode, separate_vocal, open_scenedet, align_audio, align_audio_reverse, templ_start_seconds,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!video_slug) {
        return { isError: true as const, content: [{ type: "text" as const, text: "Volcengine lip-sync requires video_slug" }] };
      }
      if (!audio_slug) {
        return { isError: true as const, content: [{ type: "text" as const, text: "Volcengine lip-sync requires audio_slug" }] };
      }

      const videoResult = await resolveVideoSlug(fs, video_slug, project_slug);
      if (!videoResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: videoResult.error }] };
      const videoInput = videoResult.value;

      const audioResult = await resolveAudioSlug(fs, audio_slug, project_slug);
      if (!audioResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: audioResult.error }] };
      const audioInput = audioResult.value;

      const videoName = `${SLUG}-${String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceVideoIds = [videoInput.assetId];
      const sourceAudioIds = [audioInput.assetId];

      const jobId = `${SLUG}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_volcengine_lipsync_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        videoInput,
        audioInput,
        sourceVideoIds,
        sourceAudioIds,
        ...(mode !== undefined ? { mode } : {}),
        ...(separate_vocal !== undefined ? { separate_vocal } : {}),
        ...(open_scenedet !== undefined ? { open_scenedet } : {}),
        ...(align_audio !== undefined ? { align_audio } : {}),
        ...(align_audio_reverse !== undefined ? { align_audio_reverse } : {}),
        ...(templ_start_seconds !== undefined ? { templ_start_seconds } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_videos: sourceVideoIds,
            source_audios: sourceAudioIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
