import type { VideocityFs } from "videocity-engine";
import { findAudioFile } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import {
  buildOutroSpec,
  orientationForAspectRatio,
} from "../remotion/qr-outro-spec.js";
import type { AspectRatio } from "../remotion/qr-outro-spec.js";
import { findImageFile } from "./_image-inputs.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export type QrOutroAssetRef = {
  assetId: string;
  filename: string;
};

type RefResult =
  | { ok: true; value: QrOutroAssetRef }
  | { ok: false; error: string };

function toolError(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function normalizeAssetId(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

async function resolveImageRef(
  fs: VideocityFs,
  raw: string,
  projectSlug: string,
  field: string,
): Promise<RefResult> {
  const assetId = normalizeAssetId(raw);
  if (!assetId.startsWith("img-")) {
    return { ok: false, error: `${field} must be an img-* asset, got: ${assetId}` };
  }
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioRef(
  fs: VideocityFs,
  raw: string,
  projectSlug: string,
): Promise<RefResult> {
  const assetId = normalizeAssetId(raw);
  if (!assetId.startsWith("aud-")) {
    return {
      ok: false,
      error: `sound_effect_slug must be an aud-* asset, got: ${assetId}`,
    };
  }
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

export function createQrOutroDef(fs: VideocityFs): ToolDef {
  return {
    name: "create_qr_outro",
    description:
      "Build a standalone animated outro from 1-4 QR image assets with a bundled impact sound or an optional audio override.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      qr_image_slugs: z
        .array(z.string())
        .min(1)
        .max(4)
        .describe("One to four QR code image asset IDs (img- prefix)"),
      sound_effect_slug: z
        .string()
        .optional()
        .describe("Optional impact sound override (aud- prefix); defaults to the bundled sound"),
      aspect_ratio: z
        .enum(["16:9", "9:16", "1:1"])
        .optional()
        .describe("Output aspect ratio (default: 16:9)"),
    },
    handler: async (args) => {
      const {
        project_slug,
        qr_image_slugs,
        sound_effect_slug,
        aspect_ratio = "16:9",
      } = args as {
        project_slug: string;
        qr_image_slugs: string[];
        sound_effect_slug?: string;
        aspect_ratio?: AspectRatio;
      };

      const qrImages: QrOutroAssetRef[] = [];
      for (const raw of qr_image_slugs) {
        const resolved = await resolveImageRef(
          fs,
          raw,
          project_slug,
          "qr_image_slugs entry",
        );
        if (!resolved.ok) return toolError(resolved.error);
        qrImages.push(resolved.value);
      }

      let soundEffect: QrOutroAssetRef | null = null;
      if (sound_effect_slug) {
        const resolved = await resolveAudioRef(fs, sound_effect_slug, project_slug);
        if (!resolved.ok) return toolError(resolved.error);
        soundEffect = resolved.value;
      }

      const spec = buildOutroSpec(aspect_ratio, qrImages.length);
      const firstQrStem = qrImages[0].assetId.replace(/^img-/, "");
      const created = await fs.createAsset(
        "vid",
        `qr-outro-${firstQrStem}`,
        project_slug,
      );
      if (!created.ok) {
        return toolError(`Failed to create output asset: ${created.error.message}`);
      }

      const assetId = created.value.assetId;
      const jobId = `render-qr-outro-${assetId}-${Date.now()}`;
      try {
        await queue.enqueue(jobId, {
          type: "render_qr_outro",
          projectSlug: project_slug,
          assetId,
          orientation: orientationForAspectRatio(aspect_ratio),
          qrImages,
          soundEffect,
          aspectRatio: aspect_ratio,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const deleted = await fs.deleteAsset(assetId, project_slug);
        if (!deleted.ok) {
          await fs.pendingTasks.forceFail(project_slug, assetId, {
            message: `Enqueue failed and rollback failed: ${deleted.error.message}`,
          });
        }
        return toolError(`Failed to enqueue QR outro: ${message}`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            asset_id: assetId,
            job_id: jobId,
            status: "enqueued",
            aspect_ratio,
            duration_seconds: spec.totalDurationSeconds,
            qr_image_slugs: qrImages.map((image) => image.assetId),
            sound_effect_source: soundEffect ? "asset" : "bundled_default",
            ...(soundEffect ? { sound_effect_slug: soundEffect.assetId } : {}),
          }),
        }],
      };
    },
  };
}
