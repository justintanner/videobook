import { describe, expect, it } from "vitest";
import {
  assertNoUnresolvedMentions,
  assertProviderPayload,
  ProviderMentionError,
  unresolvedProviderMentions,
} from "./provider-prompt-transform.js";

const IMG_ID = "01890f1c-0000-7000-8000-0000000000aa";
const VID_ID = "01890f1c-0000-7000-8000-0000000000bb";

describe("provider payload mention guards", () => {
  it("rejects unresolved grid and artifact-id mentions", () => {
    expect(unresolvedProviderMentions(
      `@a2 @${IMG_ID} @element_1 @referenceImage_1 @Image1 @image1`,
    )).toEqual(["@a2", `@${IMG_ID}`]);
    expect(unresolvedProviderMentions(
      "keep @some-handle and plain @words alone",
    )).toEqual([]);
    expect(() => assertNoUnresolvedMentions(`use @${VID_ID}`, {
      toolName: "example_tool",
    })).toThrow(ProviderMentionError);
    expect(() => assertProviderPayload(
      { input: { prompt: "use @a2" } },
      { toolName: "generate_kie_kling_3_0_video" },
    )).toThrow("@a2");
  });

  it("rejects preview placeholder URLs only at the wire boundary", () => {
    const payload = {
      input: {
        prompt: "use @Image1",
        image_urls: [`http://url.resolved.later.for/${IMG_ID}`],
      },
    };
    expect(() => assertProviderPayload(payload, {
      toolName: "preview",
    })).not.toThrow();
    expect(() => assertProviderPayload(payload, {
      toolName: "wire",
      wire: true,
    })).toThrow("placeholder");
  });
});
