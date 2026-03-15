import { describe, it, expect } from "vitest";

describe("isolate-vocals job handler", () => {
  it("exports registerIsolateVocalsJob function", async () => {
    const mod = await import("./isolate-vocals.js");
    expect(typeof mod.registerIsolateVocalsJob).toBe("function");
  });

  it("registerIsolateVocalsJob accepts a fs argument", async () => {
    const mod = await import("./isolate-vocals.js");
    expect(mod.registerIsolateVocalsJob.length).toBe(1);
  });
});
