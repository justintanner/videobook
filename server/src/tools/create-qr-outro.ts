import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

export function createQrOutroDef(fs: VideocityFs): ToolDef {
  return {
    name: "create_qr_outro",
    description: "Build a standalone QR outro video. Combines a last-frame image with 1-4 QR codes, animated in a split layout.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      last_frame_slug: z.string().describe("Image asset ID for the background frame (img- prefix)"),
      qr_image_slugs: z.array(z.string()).min(1).max(4).describe("Array of 1 to 4 QR code image asset IDs (img- prefix)"),
      sound_effect_slug: z.string().optional().describe("Optional audio asset ID for the impact sound (aud- prefix)"),
      aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional().describe("Output aspect ratio (default: 16:9)"),
    },
    handler: async (args) => {
      const {
        project_slug,
        last_frame_slug,
        qr_image_slugs,
        sound_effect_slug,
        aspect_ratio = "16:9",
      } = args as {
        project_slug: string;
        last_frame_slug: string;
        qr_image_slugs: string[];
        sound_effect_slug?: string;
        aspect_ratio?: "16:9" | "9:16" | "1:1";
      };

      if (!last_frame_slug.startsWith("img-")) {
        return { isError: true as const, content: [{ type: "text" as const, text: "last_frame_slug must start with img-" }] };
      }
      for (const slug of qr_image_slugs) {
        if (!slug.startsWith("img-")) {
          return { isError: true as const, content: [{ type: "text" as const, text: `QR image slug ${slug} must start with img-` }] };
        }
      }
      if (sound_effect_slug && !sound_effect_slug.startsWith("aud-")) {
        return { isError: true as const, content: [{ type: "text" as const, text: "sound_effect_slug must start with aud-" }] };
      }

      // Validate assets exist
      const lastFrameManifest = await fs.getManifest(last_frame_slug, project_slug);
      if (!lastFrameManifest.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Background image error: ${lastFrameManifest.error.message}` }] };
      }

      for (const slug of qr_image_slugs) {
        const manifest = await fs.getManifest(slug, project_slug);
        if (!manifest.ok) {
          return { isError: true as const, content: [{ type: "text" as const, text: `QR image error (${slug}): ${manifest.error.message}` }] };
        }
      }

      if (sound_effect_slug) {
        const sfxManifest = await fs.getManifest(sound_effect_slug, project_slug);
        if (!sfxManifest.ok) {
          return { isError: true as const, content: [{ type: "text" as const, text: `Sound effect error: ${sfxManifest.error.message}` }] };
        }
      }

      // Create new video asset
      const stem = `qr-outro-${Date.now().toString(36)}`;
      const created = await fs.createAsset("vid", stem, project_slug);
      if (!created.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create output asset: ${created.error.message}` }] };
      }

      const asset_id = created.value.assetId;
      const jobId = `render-qr-outro-${asset_id}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "render_qr_outro",
        projectSlug: project_slug,
        assetId: asset_id,
        lastFrameSlug: last_frame_slug,
        qrImageSlugs: qr_image_slugs,
        soundEffectSlug: sound_effect_slug,
        aspectRatio: aspect_ratio,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id,
            job_id: jobId,
            status: "enqueued",
            ratio: aspect_ratio,
            sources: {
              last_frame: last_frame_slug,
              qr_images: qr_image_slugs,
              sound_effect: sound_effect_slug,
            }
          }),
        }],
      };
    },
  };
}
