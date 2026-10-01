import { describe, expect, it } from "vitest";
import {
  generationInputMentions,
  scanGenerationInputTokens,
} from "./generation-input-mentions.js";

const cells = [
  { id: "target", type: "generate_video" },
  { id: "still-a", type: "image" },
  { id: "still-b", type: "generate_image" },
  { id: "start", type: "image" },
  { id: "clip", type: "split_video" },
  { id: "voice", type: "audio" },
  { id: "dub", type: "generate_audio" },
  { id: "note", type: "prompt" },
];

function edge(source: string, targetInput: string) {
  return { source, target: "target", targetInput };
}

describe("generation input mentions", () => {
  it("numbers each media kind by input slot and gives frames their own tokens", () => {
    const mentions = generationInputMentions("target", cells, [
      edge("still-b", "image_2"),
      edge("note", "prompt"),
      edge("voice", "replace_audio"),
      edge("clip", "video"),
      edge("still-a", "image"),
      edge("start", "first_frame"),
      edge("dub", "audio"),
      { source: "still-a", target: "elsewhere", targetInput: "image" },
    ]);
    expect(mentions.map(({ token, sourceCellId }) => [token, sourceCellId])).toEqual([
      ["firstframe", "start"],
      ["image1", "still-a"],
      ["image2", "still-b"],
      ["video1", "clip"],
      ["audio1", "dub"],
    ]);
  });

  it("closes numbering gaps so tokens match the provider's reference order", () => {
    const mentions = generationInputMentions("target", cells, [
      edge("still-b", "image_3"),
      edge("still-a", "media"),
    ]);
    expect(mentions.map(({ token, sourceCellId }) => [token, sourceCellId])).toEqual([
      ["image1", "still-b"],
      ["image2", "still-a"],
    ]);
  });

  it("scans only whole input tokens", () => {
    expect(scanGenerationInputTokens(
      "@Image1 meets @video12 and @firstframe; skip @image1x, @a1, image2",
    )).toEqual(["image1", "video12", "firstframe"]);
  });
});
