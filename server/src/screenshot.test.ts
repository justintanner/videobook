import { describe, it, expect } from "vitest";

describe("screenshot module", () => {
  it("exports takeScreenshot function", async () => {
    const mod = await import("./screenshot.js");
    expect(typeof mod.takeScreenshot).toBe("function");
  });
});
