import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compositeImageRegionEdit, imageRegionEditPrompt } from "../image-region-edit.js";
import { seedreamRegionReplacementRequest } from "./_image-edit-adapter.js";

describe("drawn image region edits", () => {
  it.each(["edit", "remove"] as const)("builds a valid provider request for %s without replacement images", (operation) => {
    const prompt = imageRegionEditPrompt([
      { x: 0.5, y: 0, width: 0.5, height: 0.4 },
    ], operation, "Remove the glass door but keep the person");
    const request = seedreamRegionReplacementRequest({
      imageUrls: ["https://example.test/base.png"],
      prompt,
      width: 2736,
      height: 1536,
    });
    expect(request.input.image_urls).toEqual(["https://example.test/base.png"]);
    expect(request.input.prompt).toContain("x=0.500000, y=0.000000, width=0.500000, height=0.400000");
    expect(request.input.prompt).toContain(operation === "edit"
      ? "Remove the glass door but keep the person"
      : "fill them naturally from the surrounding scene");
    expect(request.input.prompt).toContain("Preserve everything outside the selected regions exactly");
  });

  it("preserves every unselected pixel when the provider changes the whole image and output size", async () => {
    const original = await sharp({ create: {
      width: 20, height: 12, channels: 3, background: "#c81428",
    } }).png().toBuffer();
    const generated = await sharp({ create: {
      width: 40, height: 24, channels: 3, background: "#143cc8",
    } }).png().toBuffer();
    const output = await compositeImageRegionEdit(original, generated, [
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0.45, y: 0.25, width: 0.2, height: 0.5 },
    ]);
    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 20, height: 12, channels: 3 });
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const selected = (x >= 10 && y < 6) || (x >= 9 && x < 13 && y >= 3 && y < 9);
        const offset = (y * info.width + x) * info.channels;
        expect([...data.subarray(offset, offset + 3)], `pixel ${x},${y}`)
          .toEqual(selected ? [20, 60, 200] : [200, 20, 40]);
      }
    }
  });
});
