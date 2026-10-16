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

function timelineOrientation(engine: Engine): Orientation {
  return readTimeline(engine).render;
}

async function findFinalVideo(
  engine: Engine,
  files: ArtifactManifestFile[],
  assetDir: string,
  requested?: Orientation,
): Promise<{ file: ArtifactManifestFile; orientation: Orientation } | null> {
  const canonical = findCanonicalVideo(files);
  if (canonical) {
    const probe = await probeVideo(join(assetDir, canonical.name));
    if (!probe.videoStream || probe.width <= 0 || probe.height <= 0) return null;
    const orientation = orientationForDimensions(probe.width, probe.height);
    return requested && requested !== orientation ? null : { file: canonical, orientation };
  }
  const preferred = requested ?? timelineOrientation(engine);
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

export function injectFirstFrameDef(engine: Engine): ToolDef {
  return {
    name: "inject_first_frame",
    description: "Replace the first frame of a video, or of the final render, with an image asset in place, keeping runtime and audio; for final, orientation defaults to the timeline's.",
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
        engine,
        targetAssetId,
        ["video", "final"],
        "inject_first_frame target_asset_id",
      );
      if (targetGate) return targetGate;
      const isFinalTarget = artifactKindOf(engine, targetAssetId) === "final";
      const imageGate = await requireArtifactKind(engine, imageAssetId, ["image"], "inject_first_frame image_asset_id");
      if (imageGate) return imageGate;
      if (!isFinalTarget && orientation !== undefined) {
        return toolError("orientation is only valid for the final timeline render");
      }

      const [targetManifest, imageManifest] = await Promise.all([
        engine.files.manifest(targetAssetId),
        engine.files.manifest(imageAssetId),
      ]);
      if (!targetManifest.ok) return toolError(targetManifest.error.message);
      if (!imageManifest.ok) return toolError(imageManifest.error.message);

      let targetFile: ArtifactManifestFile | null;
      let targetOrientation: Orientation;
      if (isFinalTarget) {
        const resolved = await findFinalVideo(
          engine,
          targetManifest.value.files,
          targetManifest.value.path,
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
