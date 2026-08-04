import { describe, expect, it } from "vitest";
import { translatePayloadDef } from "./translate-payload.js";

function text(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("translate_payload tool", () => {
  const tool = translatePayloadDef();

  it("returns the provider payload for a known gen tool", async () => {
    const result = await tool.handler({
      tool_name: "generate_nano_banana_pro_google",
      args_json: JSON.stringify({
        prompt: "realistic cat lying in a galaxy 4k",
        aspect_ratio: "1:1",
        image_refs: ["@img-nbp-frame-reference-1", "@img-catblack"],
        character_refs: [],
        book_id: "realcat",
        _provider: "google",
      }),
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(text(result)) as { provider_path: string; payload: Record<string, unknown> };
    expect(parsed.provider_path).toBe("googleflow.v1.images()");
    expect(parsed.payload).toEqual({
      prompt: "realistic cat lying in a galaxy 4k",
      model: "nano-banana-pro",
      count: 1,
      aspectRatio: "1:1",
      reference_1: "@img-nbp-frame-reference-1",
      reference_2: "@img-catblack",
    });
  });

  it("routes _provider to the xai branch", async () => {
    const result = await tool.handler({
      tool_name: "generate_grok_imagine_image",
      args_json: JSON.stringify({
        prompt: "a cat",
        image_refs: ["@img-vancat"],
        _provider: "xai",
      }),
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(text(result)) as { provider_path: string };
    expect(parsed.provider_path).toBe("xai.post.v1.images.edits(request, { otp })");
  });

  it("errors on malformed args_json", async () => {
    const result = await tool.handler({ tool_name: "generate_gpt_image", args_json: "{nope" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Invalid JSON in args_json");
  });

  it("errors on an unknown tool name", async () => {
    const result = await tool.handler({ tool_name: "not_a_tool", args_json: "{}" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unknown tool: not_a_tool");
  });
});
