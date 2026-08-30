import { FalError } from "@apicity/fal";
import { describe, expect, it } from "vitest";
import { describeFalError } from "./_fal-shared.js";

describe("describeFalError", () => {
  it("includes the provider detail from Fal errors", () => {
    const error = new FalError(
      "Fal API error: 403",
      403,
      "authorization_error",
      undefined,
      undefined,
      { detail: "User is locked. Reason: Exhausted balance." },
    );

    expect(describeFalError(error)).toBe(
      "Fal API error: 403: User is locked. Reason: Exhausted balance.",
    );
  });

  it("preserves non-Fal error messages", () => {
    expect(describeFalError(new Error("network unavailable"))).toBe("network unavailable");
  });
});
