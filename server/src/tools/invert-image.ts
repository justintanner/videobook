import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { z } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import sharp from "sharp";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

function findOriginalImage(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  const byName = (name: string) => images.find((f) => f.name === name);
  return (
    byName("original.png")
    ?? byName("original.webp")
    ?? byName("original.jpg")
    ?? byName("original.jpeg")
    ?? images.find((f) => f.name.startsWith("original"))
    ?? null
  );
}

export function invertImageDef(fs: Engine): ToolDef {
  return {
    name: "invert_image",
    description: "In-place inverts an img-* asset and regenerates crops.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. img-my-photo)"),
      book_id: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, book_id } = args as { asset_id: string; book_id: string };

      const manifestResult = await fs.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return { isError: true, content: [{ type: "text", text: manifestResult.error.message }] };
      }

      const imageFile = findOriginalImage(manifestResult.value.files);
      if (!imageFile) {
        return { isError: true, content: [{ type: "text", text: `No original image file found in asset ${asset_id}` }] };
      }

      const rawExt = imageFile.extension ?? extname(imageFile.name);
      const extWithDot = rawExt.startsWith(".") ? rawExt : `.${rawExt}`;
      
      const readResult = await fs.files.read(asset_id, imageFile.name);
      if (!readResult.ok) {
        return { isError: true, content: [{ type: "text", text: readResult.error.message }] };
      }

      const buffer = Buffer.isBuffer(readResult.value) ? readResult.value : Buffer.from(readResult.value);
      
      let inverted: Buffer;
      try {
        inverted = await sharp(buffer).negate({ alpha: false }).toBuffer();
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Invert failed: ${err instanceof Error ? err.message : String(err)}` }] };
      }

      const writeResult = await fs.files.write(asset_id, imageFile.name, inverted);
      if (!writeResult.ok) {
        return { isError: true, content: [{ type: "text", text: writeResult.error.message }] };
      }

      const metadataResult = await fs.metadata.artifacts.read(asset_id, "original");
      const provenance = metadataResult.ok && metadataResult.value ? metadataResult.value : { origin: "invert_image" };

      const jobId = `invert-${asset_id}-${Date.now()}`;
      await queue.enqueueAndWait(jobId, {
        type: "process_image",
        assetId: asset_id,
        bookId: book_id,
        extension: extWithDot,
        provenance,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ asset_id, status: "completed" }) }],
      };
    },
  };
}
