import { describe, it, expect } from "vitest";

describe("complete-kie-task job handler", () => {
  it("exports registerCompleteKieTaskJob function", async () => {
    const mod = await import("./complete-kie-task.js");
    expect(typeof mod.registerCompleteKieTaskJob).toBe("function");
  });

  it("registerCompleteKieTaskJob accepts a fs argument", async () => {
    const mod = await import("./complete-kie-task.js");
    expect(mod.registerCompleteKieTaskJob.length).toBe(1);
  });
});
