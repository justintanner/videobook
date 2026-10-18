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

  it("formats structured validation fields without dumping inputs or context", () => {
    const error = new FalError("Fal API error: 422", 422, "validation_error", undefined, undefined, {
      detail: [{ loc: ["body", "start_time"], msg: "Must be within the source video", input: "private-input", ctx: { secret: "private-context" } },
        { loc: ["body", "reference_video_urls", 0], msg: "Invalid duration" }],
    });
    expect(describeFalError(error)).toBe("Fal API error: 422: start_time: Must be within the source video; reference_video_urls.0: Invalid duration");
  });

  it.each([undefined, null, {}, [null, 3, { input: "ignored" }]])("falls back for unusable details %j", (detail) => {
    expect(describeFalError(new FalError("Fal API error: 422", 422, "validation_error", undefined, undefined, { detail })))
      .toBe("Fal API error: 422");
  });
});
