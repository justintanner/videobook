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
      includeQr: true,
      handleVerticalPercent: 62,
      startSeconds: 0.2,
      endSeconds: 0.8,
    })).toBe(
      "[1:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.5[qr];"
      + "[2:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.5[handle];"
      + "[0:v][qr]overlay=(main_w-overlay_w)/2:6:format=auto:enable='between(t,0.2,0.8)'[withqr];"
      + "[withqr][handle]overlay=(main_w-overlay_w)/2:main_h*62/100-overlay_h/2:format=auto"
      + ":enable='between(t,0.2,0.8)'[vout]",
    );
  });

  it("uses the default handle vertical position for handle-only output", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "bottom-right",
      opacity: 0.5,
      userScale: 1,
      includeQr: false,
    })).toBe(
      "[1:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.5[handle];"
      + "[0:v][handle]overlay=(main_w-overlay_w)/2:main_h*33/100-overlay_h/2:format=auto[vout]",
    );
  });

  it("supports open-ended and whole-clip timing", () => {
    expect(burnWatermarkEnable()).toBe("");
    expect(burnWatermarkEnable(1.5)).toBe(":enable='gte(t,1.5)'");
    expect(burnWatermarkEnable(undefined, 4)).toBe(":enable='between(t,0,4)'");
  });
});
