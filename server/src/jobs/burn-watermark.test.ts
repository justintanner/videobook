import { describe, expect, it } from "vitest";
import {
  buildBurnWatermarkFilter,
  burnWatermarkEnable,
  burnWatermarkFades,
  burnWatermarkInputArgs,
  burnWatermarkLoopSeconds,
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
      + "[2:v]scale=-2:34,format=rgba,colorchannelmixer=aa=0.7[handle];"
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
      "[1:v]scale=-2:34,format=rgba,colorchannelmixer=aa=0.5[handle];"
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

  it("places the handle on the QR at the QR corner", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "bottom-right",
      userScale: 1,
      includeQr: true,
      includeHandle: true,
      handlePlacement: "above-qr",
    })).toBe(
      "[1:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.5[qr];"
      + "[2:v]scale=38:-2,format=rgba,colorchannelmixer=aa=0.5[handle];"
      + "[0:v][qr]overlay=main_w-overlay_w-6:main_h-overlay_h-6:format=auto[withqr];"
      + "[withqr][handle]overlay=276:188:format=auto[vout]",
    );
  });

  it("scales independent handle height from vertical padding", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "bottom-right",
      userScale: 1,
      includeQr: false,
      includeHandle: true,
      handlePaddingY: 0,
    })).toBe(
      "[1:v]scale=-2:12,format=rgba,colorchannelmixer=aa=0.5[handle];"
      + "[0:v][handle]overlay=(main_w-overlay_w)/2:main_h*33/100-overlay_h/2:format=auto[vout]",
    );
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

  it("fades a mid-clip window in and out around its hard enable window", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "bottom-right",
      userScale: 1,
      includeQr: true,
      includeHandle: false,
      durationSeconds: 10,
      fadeSeconds: 0.5,
      qrStartSeconds: 2,
      qrEndSeconds: 6,
    })).toBe(
      "[1:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.5"
      + ",fade=t=in:st=2:d=0.5:alpha=1,fade=t=out:st=5.5:d=0.5:alpha=1[qr];"
      + "[0:v][qr]overlay=main_w-overlay_w-6:main_h-overlay_h-6:format=auto"
      + ":enable='between(t,2,6)'[vout]",
    );
  });

  it("keeps hard edges at the clip boundaries and fades each watermark on its own window", () => {
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "bottom-right",
      userScale: 1,
      includeQr: true,
      includeHandle: true,
      durationSeconds: 10,
      fadeSeconds: 0.5,
      qrStartSeconds: 0,
      qrEndSeconds: 6,
      handleStartSeconds: 3,
    })).toBe(
      "[1:v]scale=-2:38,format=rgba,colorchannelmixer=aa=0.5"
      + ",fade=t=out:st=5.5:d=0.5:alpha=1[qr];"
      + "[2:v]scale=-2:34,format=rgba,colorchannelmixer=aa=0.5"
      + ",fade=t=in:st=3:d=0.5:alpha=1[handle];"
      + "[0:v][qr]overlay=main_w-overlay_w-6:main_h-overlay_h-6:format=auto"
      + ":enable='between(t,0,6)'[withqr];"
      + "[withqr][handle]overlay=(main_w-overlay_w)/2:main_h*33/100-overlay_h/2:format=auto"
      + ":enable='gte(t,3)'[vout]",
    );
    expect(buildBurnWatermarkFilter({
      width: 320,
      height: 240,
      corner: "bottom-right",
      userScale: 1,
      includeQr: true,
      includeHandle: false,
      durationSeconds: 10,
      fadeSeconds: 0.5,
    })).not.toContain("fade=");
  });

  it("sizes fades to the window and the clip end", () => {
    expect(burnWatermarkFades(2, 6, 10, 0.5)).toEqual({ fadeIn: 0.5, fadeOut: 0.5 });
    expect(burnWatermarkFades(undefined, undefined, 10, 0.5)).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(burnWatermarkFades(0, 10, 10, 0.5)).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(burnWatermarkFades(2, 12, 10, 0.5)).toEqual({ fadeIn: 0.5, fadeOut: 0 });
    expect(burnWatermarkFades(2, 2.6, 10, 0.5)).toEqual({ fadeIn: 0.3, fadeOut: 0.3 });
    expect(burnWatermarkFades(2, 6, 10, 0)).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it("loops a badge only while it fades, and never past the clip", () => {
    expect(burnWatermarkLoopSeconds({ fadeIn: 0, fadeOut: 0 }, 2, 6, 10)).toBeNull();
    expect(burnWatermarkLoopSeconds({ fadeIn: 0.5, fadeOut: 0 }, 2, undefined, 10)).toBe(2.75);
    expect(burnWatermarkLoopSeconds({ fadeIn: 0.5, fadeOut: 0.5 }, 2, 6, 10)).toBe(6.25);
    expect(burnWatermarkLoopSeconds({ fadeIn: 0.3, fadeOut: 0.3 }, 0.2, 0.8, 1)).toBe(1);
    expect(burnWatermarkInputArgs("/badge.png", null, "12/1")).toEqual(["-i", "/badge.png"]);
    expect(burnWatermarkInputArgs("/badge.png", 2.75, "30000/1001")).toEqual([
      "-loop", "1", "-framerate", "30000/1001", "-t", "2.75", "-i", "/badge.png",
    ]);
  });
});
