import { describe, expect, it } from "vitest";
import {
  buildBurnWatermarkFilter,
  burnWatermarkEnable,
} from "./burn-watermark.js";

describe("burn watermark filter", () => {
  it("applies independent opacity and timing to QR and handle overlays", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "top-center",
      qrOpacity: 0.35,
      handleOpacity: 0.7,
      userScale: 1,
      includeQr: true,
      includeHandle: true,
      handleVerticalPercent: 62,
      qrStartSeconds: 0.1,
      qrEndSeconds: 0.6,
      handleStartSeconds: 0.2,
      handleEndSeconds: 0.8,
    })).toBe(
      "[1:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.35[qr];"
      + "[2:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.7[handle];"
      + "[0:v][qr]overlay=(main_w-overlay_w)/2:6:format=auto:enable='between(t,0.1,0.6)'[withqr];"
      + "[withqr][handle]overlay=(main_w-overlay_w)/2:main_h*62/100-overlay_h/2:format=auto"
      + ":enable='between(t,0.2,0.8)'[vout]",
    );
  });

  it("uses the default handle vertical position for handle-only output", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "bottom-right",
      userScale: 1,
      includeQr: false,
      includeHandle: true,
    })).toBe(
      "[1:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.5[handle];"
      + "[0:v][handle]overlay=(main_w-overlay_w)/2:main_h*33/100-overlay_h/2:format=auto[vout]",
    );
  });

  it("keeps shared opacity and timing as legacy fallbacks", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "bottom-right",
      opacity: 0.25,
      userScale: 1,
      includeQr: false,
      includeHandle: true,
      startSeconds: 0.3,
      endSeconds: 0.9,
    })).toContain(
      "colorchannelmixer=aa=0.25[handle];"
      + "[0:v][handle]overlay=(main_w-overlay_w)/2:main_h*33/100-overlay_h/2:format=auto"
      + ":enable='between(t,0.3,0.9)'[vout]",
    );
  });

  it("supports open-ended and whole-clip timing", () => {
    expect(burnWatermarkEnable()).toBe("");
    expect(burnWatermarkEnable(1.5)).toBe(":enable='gte(t,1.5)'");
    expect(burnWatermarkEnable(undefined, 4)).toBe(":enable='between(t,0,4)'");
  });

  it("builds a QR-only filter without a handle input", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "bottom-right",
      qrOpacity: 0.4,
      userScale: 1,
      includeQr: true,
      includeHandle: false,
      qrStartSeconds: 0.1,
      qrEndSeconds: 0.6,
    })).toBe(
      "[1:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.4[qr];"
      + "[0:v][qr]overlay=main_w-overlay_w-6:main_h-overlay_h-6:format=auto"
      + ":enable='between(t,0.1,0.6)'[vout]",
    );
  });
});
