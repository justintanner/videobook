import type { ArtifactManifestFile, Engine } from "videobook-engine";
import { z } from "zod";
import { extname, join } from "node:path";
import { probeVideo } from "../ffmpeg.js";
import { queue } from "../queue.js";
import { readTimeline } from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";
import { artifactKindOf, requireArtifactKind, toolError } from "./_shared.js";

type Orientation = "landscape" | "portrait" | "square";

const FINAL_FILENAMES: Record<Orientation, string> = {
  landscape: "timeline_landscape.mp4",
  portrait: "timeline_portrait.mp4",
  square: "timeline_square.mp4",
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function cleanAssetId(value: string): string {
  return value.trim().replace(/^@/, "");
}

function orientationForDimensions(width: number, height: number): Orientation {
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

function findImageFile(files: ArtifactManifestFile[], orientation: Orientation): ArtifactManifestFile | null {
  const preferred = files.find((file) => file.name.toLowerCase() === `${orientation}.jpg`);
  if (preferred) return preferred;
  return files.find((file) => {
    const extension = extname(file.name).toLowerCase();
    return file.name.toLowerCase().startsWith("original.") && IMAGE_EXTENSIONS.has(extension);
  }) ?? null;
}

function findCanonicalVideo(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  return files.find((file) => /^original\.(mp4|mov)$/i.test(file.name)) ?? null;
}

function timelineOrientation(fs: Engine): Orientation {
  return readTimeline(fs).render;
}

async function findFinalVideo(
  fs: Engine,
  files: ArtifactManifestFile[],
  requested?: Orientation,
): Promise<{ file: ArtifactManifestFile; orientation: Orientation } | null> {
  const preferred = requested ?? timelineOrientation(fs);
  const candidates: Orientation[] = [
    ...(preferred ? [preferred] : []),
    "landscape",
    "portrait",
    "square",
  ];
  for (const orientation of [...new Set(candidates)]) {
    const filename = FINAL_FILENAMES[orientation];
    const file = files.find((entry) => entry.name.toLowerCase() === filename);
    if (file) return { file, orientation };
    if (requested === orientation) return null;
  }
  return null;
}

export function injectFirstFrameDef(fs: Engine): ToolDef {
  return {
    name: "inject_first_frame",
    description: "Replace exactly the first frame of a video artifact or the final video with an image artifact in place. Preserves runtime and stream-copies the original audio unchanged. For final, orientation defaults to the active timeline orientation.",
    schema: {
      target_asset_id: z.string().describe("Target video artifact id, or final"),
      image_asset_id: z.string().describe("Source image artifact id"),
      book_id: z.string().describe("Book id"),
      orientation: z
        .enum(["landscape", "portrait", "square"])
        .optional()
        .describe("Final output orientation; defaults to the active timeline orientation"),
    },
    handler: async (args) => {
      const {
        target_asset_id,
        image_asset_id,
        book_id,
        orientation,
      } = args as {
        target_asset_id: string;
        image_asset_id: string;
        book_id: string;
        orientation?: Orientation;
      };
      const targetAssetId = cleanAssetId(target_asset_id);
      const imageAssetId = cleanAssetId(image_asset_id);

      // The timeline output is a "final"-kind artifact, so it is addressed by
      // id like any other; only its kind distinguishes it from a plain clip.
      const targetGate = await requireArtifactKind(
        fs,
        targetAssetId,
        ["video", "final"],
        "inject_first_frame target_asset_id",
      );
      if (targetGate) return targetGate;
      const isFinalTarget = artifactKindOf(fs, targetAssetId) === "final";
      const imageGate = await requireArtifactKind(fs, imageAssetId, ["image"], "inject_first_frame image_asset_id");
      if (imageGate) return imageGate;
      if (!isFinalTarget && orientation !== undefined) {
        return toolError("orientation is only valid for the final timeline render");
      }

      const [targetManifest, imageManifest] = await Promise.all([
        fs.files.manifest(targetAssetId),
        fs.files.manifest(imageAssetId),
      ]);
      if (!targetManifest.ok) return toolError(targetManifest.error.message);
      if (!imageManifest.ok) return toolError(imageManifest.error.message);

      let targetFile: ArtifactManifestFile | null;
      let targetOrientation: Orientation;
      if (isFinalTarget) {
        const resolved = await findFinalVideo(
          fs,
          targetManifest.value.files,
          orientation,
        );
        if (!resolved) {
          const detail = orientation ? ` for ${orientation}` : "";
          return toolError(`No final video output found${detail}`);
        }
        targetFile = resolved.file;
        targetOrientation = resolved.orientation;
      } else {
        targetFile = findCanonicalVideo(targetManifest.value.files);
        if (!targetFile) return toolError(`No original MP4 or MOV found in asset ${targetAssetId}`);
        const probe = await probeVideo(join(targetManifest.value.path, targetFile.name));
        if (probe.videoCodec === null || probe.width <= 0 || probe.height <= 0) {
          return toolError(`No usable video stream found in asset ${targetAssetId}`);
        }
        targetOrientation = orientationForDimensions(probe.width, probe.height);
      }

      const imageFile = findImageFile(imageManifest.value.files, targetOrientation);
      if (!imageFile) return toolError(`No usable image file found in asset ${imageAssetId}`);

      const now = Date.now();
      const extension = extname(targetFile.name).toLowerCase();
      const outputFilename = `.inject-first-frame-${now}${extension}`;
      const jobId = `inject-first-frame-${targetAssetId}-${now}`;
      await queue.enqueue(jobId, {
        type: "inject_first_frame",
        assetId: targetAssetId,
        assetDir: targetManifest.value.path,
        targetFilename: targetFile.name,
        inputPath: join(targetManifest.value.path, targetFile.name),
        outputPath: join(targetManifest.value.path, outputFilename),
        imageAssetId,
        imagePath: join(imageManifest.value.path, imageFile.name),
        bookId: book_id,
        orientation: isFinalTarget ? targetOrientation : null,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            target_asset_id: targetAssetId,
            image_asset_id: imageAssetId,
            target_filename: targetFile.name,
            orientation: isFinalTarget ? targetOrientation : null,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
