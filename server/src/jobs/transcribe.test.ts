import { describe, it, expect } from "vitest";

describe("transcribe job handler", () => {
  it("exports registerTranscribeJob function", async () => {
    const mod = await import("./transcribe.js");
    expect(typeof mod.registerTranscribeJob).toBe("function");
  });

  it("registerTranscribeJob accepts a fs argument", async () => {
    const mod = await import("./transcribe.js");
    expect(mod.registerTranscribeJob.length).toBe(1);
  });
});
