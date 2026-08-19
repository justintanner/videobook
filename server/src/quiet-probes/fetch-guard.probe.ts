import { describe, it } from "vitest";

describe("fetch guard probe", () => {
  it("offender", async () => {
    await fetch("https://example.com/blocked").catch(() => undefined);
  });
});
