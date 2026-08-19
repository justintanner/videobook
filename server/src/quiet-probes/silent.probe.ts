import { describe, expect, it } from "vitest";

describe("silent probe", () => {
  it("passes", () => {
    console.log("[probe-pass] should stay hidden");
    expect(1).toBe(1);
  });

  it("fails", () => {
    console.log("[probe-fail] should stay visible");
    expect(1).toBe(0);
  });
});
