import { describe, expect, it } from "vitest";
import { createEncoderFallback, hardwareEncoderFailed } from "./remotion-encoding.js";

const NVENC_FAILURE = [
  "ffmpeg version n7.1 Copyright (c) 2000-2024 the FFmpeg developers",
  "[h264_nvenc @ 0x608059289340] Cannot load libcuda.so.1",
  "[vost#0:0/h264_nvenc @ 0x60805928a480] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.",
  "Conversion failed!",
].join("\n");

function recorder(failWith: (hardwareAcceleration: string) => Error | null) {
  const calls: string[] = [];
  const render = async (hardwareAcceleration: "if-possible" | "disable") => {
    calls.push(hardwareAcceleration);
    const failure = failWith(hardwareAcceleration);
    if (failure) throw failure;
    return `rendered with ${hardwareAcceleration}`;
  };
  return { calls, render };
}

describe("renderWithEncoderFallback", () => {
  it("renders in software after a hardware encoder fails and keeps doing so", async () => {
    const fallback = createEncoderFallback();
    const { calls, render } = recorder((mode) => (mode === "if-possible" ? new Error(NVENC_FAILURE) : null));
    await expect(fallback(render)).resolves.toBe("rendered with disable");
    await expect(fallback(render)).resolves.toBe("rendered with disable");
    expect(calls).toEqual(["if-possible", "disable", "disable"]);
  });

  it("keeps hardware encoding where it works", async () => {
    const fallback = createEncoderFallback();
    const { calls, render } = recorder(() => null);
    await fallback(render);
    await fallback(render);
    expect(calls).toEqual(["if-possible", "if-possible"]);
  });

  it("rethrows other render failures without a second attempt", async () => {
    const fallback = createEncoderFallback();
    const { calls, render } = recorder(() => new Error("A delayRender() \"Loading subtitle fonts\" was called but not cleared after 30000ms"));
    await expect(fallback(render)).rejects.toThrow(/delayRender/u);
    expect(calls).toEqual(["if-possible"]);
  });

  it("recognises hardware encoders by name only", () => {
    expect(hardwareEncoderFailed(new Error(NVENC_FAILURE))).toBe(true);
    expect(hardwareEncoderFailed(new Error("[h264_videotoolbox @ 0x1] Error: cannot create compression session"))).toBe(true);
    expect(hardwareEncoderFailed(new Error("[libx264 @ 0x1] width not divisible by 2"))).toBe(false);
    expect(hardwareEncoderFailed("h264_nvenc")).toBe(false);
  });
});
