import sharp from "sharp";
import type { ImageSubjectNormalizedBox } from "./image-subject-map.js";

export function imageRegionEditPrompt(
  regions: readonly ImageSubjectNormalizedBox[],
  operation: "edit" | "remove",
  prompt: string,
): string {
  const targets = regions.map((box, index) =>
    `Region ${index + 1}: normalized box x=${box.x.toFixed(6)}, y=${box.y.toFixed(6)}, width=${box.width.toFixed(6)}, height=${box.height.toFixed(6)}`);
  const instruction = operation === "remove"
    ? "Remove the contents of the selected regions and fill them naturally from the surrounding scene."
    : prompt.trim();
  return [
    instruction,
    "Apply the change only inside the following regions of the input image. Coordinates run from 0 to 1, starting at the top-left corner.",
    ...targets,
    "Keep the same image dimensions, composition and camera framing. Preserve everything outside the selected regions exactly.",
  ].join("\n");
}

export async function compositeImageRegionEdit(
  original: Buffer,
  generated: Buffer,
  regions: readonly ImageSubjectNormalizedBox[],
): Promise<Buffer> {
  const source = await sharp(original).rotate().png().toBuffer();
  const { width, height } = await sharp(source).metadata();
  if (!width || !height) throw new Error("Could not determine source image dimensions");
  const edited = await sharp(generated).rotate().resize(width, height, { fit: "fill" })
    .png().toBuffer();
  const overlays = await Promise.all(regions.map(async (box) => {
    const left = Math.min(width - 1, Math.floor(box.x * width));
    const top = Math.min(height - 1, Math.floor(box.y * height));
    const right = Math.min(width, Math.max(left + 1, Math.ceil((box.x + box.width) * width)));
    const bottom = Math.min(height, Math.max(top + 1, Math.ceil((box.y + box.height) * height)));
    const input = await sharp(edited).extract({
      left, top, width: right - left, height: bottom - top,
    }).toBuffer();
    return { input, left, top };
  }));
  return sharp(source).composite(overlays).png().toBuffer();
}
