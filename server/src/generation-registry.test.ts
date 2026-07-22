import { describe, it, expect } from "vitest";
import {
  GENERATION_ACTIONS,
  getCanonicalName,
  getActionSpec,
  isGenerationAction,
  registerGenerationTool,
} from "./generation-registry.js";
import type { ToolDef } from "./tools/tool-def.js";
import { z } from "zod";

describe("generation-registry", () => {
  it("has 92 audited generation action specifications", () => {
    expect(GENERATION_ACTIONS.length).toBe(92);
  });

  it("resolves legacy names and aliases to canonical names", () => {
    expect(getCanonicalName("generate_grok_imagine_video")).toBe("generate_kie_grok_imagine_image_to_video");
    expect(getCanonicalName("generate_kie_grok_imagine_image_to_video")).toBe("generate_kie_grok_imagine_image_to_video");
    expect(getCanonicalName("preview_video")).toBe("prepare_video_generation");
    expect(getCanonicalName("sync")).toBe("reconcile_project_work");
    expect(getCanonicalName("unknown_tool")).toBe("unknown_tool");
  });

  it("returns action spec for canonical or alias names", () => {
    const spec = getActionSpec("generate_wan27_i2v_video");
    expect(spec).toBeDefined();
    expect(spec?.canonical_name).toBe("generate_kie_wan_2_7_image_to_video");
    expect(spec?.provider).toBe("kie");
    expect(spec?.job_task_discriminator).toBe("wan27_video_gen");
  });

  it("identifies generation actions correctly", () => {
    expect(isGenerationAction("generate_grok_imagine_video")).toBe(true);
    expect(isGenerationAction("prepare_video_generation")).toBe(true);
    expect(isGenerationAction("trim_video")).toBe(false);
  });

  it("registers canonical tool and compatibility aliases without duplicating handlers", () => {
    const dummyToolDef: ToolDef = {
      name: "generate_grok_imagine_video",
      description: "Generate video with Grok",
      schema: { prompt: z.string() },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };

    const registered = registerGenerationTool(dummyToolDef);
    expect(registered.length).toBe(2);
    expect(registered[0].name).toBe("generate_kie_grok_imagine_image_to_video");
    expect(registered[1].name).toBe("generate_grok_imagine_video");
    expect(registered[1].description).toContain("[DEPRECATED ALIAS");
    expect(registered[0].handler).toBe(dummyToolDef.handler);
    expect(registered[1].handler).toBe(dummyToolDef.handler);
  });
});
