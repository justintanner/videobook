import { describe, expect, it } from "vitest";
import {
  buildBurnWatermarkFilter,
  burnWatermarkEnable,
} from "./burn-watermark.js";

describe("burn watermark filter", () => {
  it("positions the badge and gates it to an explicit time window", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "top-center",
      opacity: 0.5,
      userScale: 1,
      startSeconds: 0.2,
      endSeconds: 0.8,
    })).toBe(
      "[1:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.5[wm];"
      + "[0:v][wm]overlay=(main_w-overlay_w)/2:6:format=auto:enable='between(t,0.2,0.8)'[vout]",
    );
  });

  it("supports open-ended and whole-clip timing", () => {
    expect(burnWatermarkEnable()).toBe("");
    expect(burnWatermarkEnable(1.5)).toBe(":enable='gte(t,1.5)'");
    expect(burnWatermarkEnable(undefined, 4)).toBe(":enable='between(t,0,4)'");
  });
});
