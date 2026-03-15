import { describe, it, expect } from "vitest";

describe("download-video job handler", () => {
  it("exports registerDownloadVideoJob function", async () => {
    const mod = await import("./download-video.js");
    expect(typeof mod.registerDownloadVideoJob).toBe("function");
  });

  it("registerDownloadVideoJob accepts a fs argument", async () => {
    const mod = await import("./download-video.js");
    expect(mod.registerDownloadVideoJob.length).toBe(1);
  });
});
