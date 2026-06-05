import type { VideocityFs, AssetManifestFile } from "vc-engine";
import { z } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function describeImageDef(fs: VideocityFs): ToolDef {
  return {
    name: "describe_image",
    description:
      "Analyze an image asset with vision and create a new script-* asset containing a reproduction-ready prompt (index.md). Returns immediately after enqueueing; sync reports status=\"generating\" until the markdown is written.",
    schema: {
      asset_id: z.string().describe("Image asset ID (img-*)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as {
        asset_id: string;
        project_slug: string;
      };

      if (!asset_id.startsWith("img-")) {
        return error(`describe_image only accepts img-* assets, got: ${asset_id}`);
      }

      if (!process.env.OPENAI_API_KEY) {
        return error("OPENAI_API_KEY is not set");
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return error(manifestResult.error.message);
      }

      const imageFile = findImageFile(manifestResult.value.files);
      if (!imageFile) {
        return error(`No image file found in asset ${asset_id}`);
      }

      const scriptName = `desc ${asset_id.replace(/^img-/, "")}`;
      const createResult = await fs.createAsset("script", scriptName, project_slug);
      if (!createResult.ok) {
        return error(`Failed to create script asset: ${createResult.error.message}`);
      }
      const { assetId: scriptAssetId } = createResult.value;

      const jobId = `describe-image-${asset_id}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "describe_image",
        sourceAssetId: asset_id,
        sourceImageFilename: imageFile.name,
        assetId: scriptAssetId,
        projectSlug: project_slug,
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

