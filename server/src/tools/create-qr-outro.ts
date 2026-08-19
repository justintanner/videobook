import type { Engine } from "videobook-engine";
import { findAudioFile } from "videobook-engine";
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
  engine: Engine,
  raw: string,
  field: string,
): Promise<RefResult> {
  const assetId = normalizeAssetId(raw);
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "image") {
    return { ok: false, error: `${field} must be an image artifact, got ${artifact.value.kind}: ${assetId}` };
  }
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findImageFile(manifest.value.files);
  if (!file) return { ok: false, error: `No image file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioRef(
  engine: Engine,
  raw: string,
): Promise<RefResult> {
  const assetId = normalizeAssetId(raw);
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return { ok: false, error: artifact.error.message };
  if (artifact.value.kind !== "audio") {
    return {
      ok: false,
      error: `sound_effect_ref must be an audio artifact, got ${artifact.value.kind}: ${assetId}`,
    };
  }
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, "audio");
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

export function createQrOutroDef(engine: Engine): ToolDef {
  return {
    name: "create_qr_outro",
    description:
      "Build a standalone animated outro from 1-4 QR image assets with configurable duration and optional impact audio.",
    schema: {
      book_id: z.string().describe("Book id"),
      qr_image_refs: z
        .array(z.string())
        .min(1)
        .max(4)
        .describe("One to four QR code image artifact ids"),
      sound_effect_ref: z
        .string()
        .optional()
        .describe("Optional impact sound override (audio artifact id); defaults to the bundled sound"),
      aspect_ratio: z
        .enum(["16:9", "9:16", "1:1"])
        .optional()
        .describe("Output aspect ratio (default: 16:9)"),
      duration_seconds: z
        .number()
        .min(3)
        .max(60)
        .optional()
        .describe("Output duration in seconds from 3 to 60; defaults to the animation minimum"),
      include_audio: z
        .boolean()
        .optional()
        .describe("Include impact audio (default: true); set false for a silent output"),
    },
    handler: async (args) => {
      const {
        book_id,
        qr_image_refs,
        sound_effect_ref,
        aspect_ratio = "16:9",
        duration_seconds,
        include_audio = true,
      } = args as {
        book_id: string;
        qr_image_refs: string[];
        sound_effect_ref?: string;
        aspect_ratio?: AspectRatio;
        duration_seconds?: number;
        include_audio?: boolean;
      };

      if (!include_audio && sound_effect_ref) {
        return toolError("sound_effect_ref cannot be used when include_audio is false");
      }

      const qrImages: QrOutroAssetRef[] = [];
      for (const raw of qr_image_refs) {
        const resolved = await resolveImageRef(
          engine,
          raw,
          "qr_image_refs entry",
        );
        if (!resolved.ok) return toolError(resolved.error);
        qrImages.push(resolved.value);
      }

      let soundEffect: QrOutroAssetRef | null = null;
      if (include_audio && sound_effect_ref) {
        const resolved = await resolveAudioRef(engine, sound_effect_ref);
        if (!resolved.ok) return toolError(resolved.error);
        soundEffect = resolved.value;
      }

      const spec = buildOutroSpec(
        aspect_ratio,
        qrImages.length,
        duration_seconds,
      );
      const created = await engine.artifacts.create("vid", `qr-outro-${qrImages[0].assetId}`
      );
      if (!created.ok) {
        return toolError(`Failed to create output asset: ${created.error.message}`);
      }

      const assetId = created.value.artifactId;
      const jobId = `render-qr-outro-${assetId}-${Date.now()}`;
      try {
        await queue.enqueue(jobId, {
          type: "render_qr_outro",
          bookId: book_id,
          assetId,
          orientation: orientationForAspectRatio(aspect_ratio),
          qrImages,
          soundEffect,
          aspectRatio: aspect_ratio,
          durationSeconds: spec.totalDurationSeconds,
          includeAudio: include_audio,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const deleted = await engine.artifacts.delete(assetId);
        if (!deleted.ok) {
          await engine.jobs.pending.forceFail(assetId, {
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
            qr_image_refs: qrImages.map((image) => image.assetId),
            include_audio,
            sound_effect_source: include_audio
              ? soundEffect ? "asset" : "bundled_default"
              : "none",
            ...(soundEffect ? { sound_effect_ref: soundEffect.assetId } : {}),
          }),
        }],
      };
    },
  };
}
