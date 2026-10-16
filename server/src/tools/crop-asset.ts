import type { Engine } from "videobook-engine";
import { z } from "zod";
import { cropImageDef } from "./crop-image.js";
import { cropVideoDef } from "./crop-video.js";
import type { ToolDef } from "./tool-def.js";

export function cropAssetDef(engine: Engine): ToolDef {
  const image = cropImageDef(engine);
  const video = cropVideoDef(engine);
  return {
    name: "crop_asset",
    description: "Crop an image or video in place to a 16:9, 9:16 or 1:1 region given as 0-1 fractions (x, y, w, h), resized to 1920x1080, 1080x1920 or 1080x1080.",
    schema: { ...image.schema, asset_id: z.string().describe("Image or video artifact id") },
    handler: async (args) => {
      const artifact = engine.artifacts.get(String(args.asset_id));
      if (!artifact.ok) return { isError: true, content: [{ type: "text", text: artifact.error.message }] };
      return artifact.value.kind === "image" ? image.handler(args) : video.handler(args);
    },
  };
}
