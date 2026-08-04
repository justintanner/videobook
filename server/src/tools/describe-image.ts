import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { z } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function describeImageDef(fs: Engine): ToolDef {
  return {
    name: "describe_image",
    description:
      "Analyze an image asset with vision and create a new script asset containing a reproduction-ready prompt (index.md). Returns immediately after enqueueing; reconcile_project_work reports status=\"generating\" until the markdown is written.",
    schema: {
      asset_id: z.string().describe("Image artifact id"),
      book_id: z.string().describe("Book UUID"),
    },
    handler: async (args) => {
      const { asset_id, book_id } = args as {
        asset_id: string;
        book_id: string;
      };

      const sourceArtifact = fs.artifacts.get(asset_id);
      if (!sourceArtifact.ok) return error(sourceArtifact.error.message);
      if (sourceArtifact.value.kind !== "image") {
        return error(`describe_image only accepts image artifacts, got ${sourceArtifact.value.kind} artifact ${asset_id}`);
      }

      if (!process.env.OPENAI_API_KEY) {
        return error("OPENAI_API_KEY is not set");
      }

      const manifestResult = await fs.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return error(manifestResult.error.message);
      }

      const imageFile = findImageFile(manifestResult.value.files);
      if (!imageFile) {
        return error(`No image file found in artifact ${asset_id}`);
      }

      const scriptName = `desc ${sourceArtifact.value.label ?? asset_id}`;
      const createResult = await fs.artifacts.create("script", scriptName);
      if (!createResult.ok) {
        return error(`Failed to create script asset: ${createResult.error.message}`);
      }
      const { artifactId: scriptAssetId } = createResult.value;

      const jobId = `describe-image-${asset_id}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "describe_image",
        sourceAssetId: asset_id,
        sourceImageFilename: imageFile.name,
        assetId: scriptAssetId,
        bookId: book_id,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            source_asset_id: asset_id,
            script_asset_id: scriptAssetId,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
