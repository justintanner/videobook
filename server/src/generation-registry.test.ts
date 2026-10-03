import { scopedEngine } from "./engine.js";
import { describe, expect, it } from "vitest";
import {
  GENERATION_ACTIONS,
  RETIRED_GENERATION_ACTIONS,
  getActionSpec,
  getCanonicalName,
  isGenerationAction,
} from "./generation-registry.js";
import { getAllToolDefs } from "./tools/index.js";

describe("generation-registry", () => {
  it("has 79 audited generation action specifications", () => {
    expect(GENERATION_ACTIONS).toHaveLength(79);
  });

  it("resolves historical names to canonical names", () => {
    expect(getCanonicalName("generate_grok_imagine_video")).toBe("generate_kie_grok_imagine_image_to_video");
    expect(getCanonicalName("generate_seedance25_video")).toBe("generate_kie_seedance_2_5_video");
    expect(getCanonicalName("generate_grok_imagine_ref_video")).toBe("generate_xai_grok_imagine_video");
    expect(getCanonicalName("generate_xai_grok_imagine_reference_to_video")).toBe("generate_xai_grok_imagine_video");
    expect(getCanonicalName("preview_video")).toBe("prepare_video_generation");
    expect(getCanonicalName("sync")).toBe("reconcile_project_work");
    expect(getCanonicalName("unknown_tool")).toBe("unknown_tool");
  });

  it("returns action metadata for canonical and historical names", () => {
    const spec = getActionSpec("generate_wan27_i2v_video");
    expect(spec).toBeDefined();
    expect(spec?.canonical_name).toBe("generate_kie_wan_2_7_image_to_video");
    expect(spec?.provider).toBe("kie");
    expect(spec?.job_task_discriminator).toBe("wan27_video_gen");
  });

  it("identifies generation actions", () => {
    expect(isGenerationAction("generate_grok_imagine_video")).toBe(true);
    expect(isGenerationAction("prepare_video_generation")).toBe(true);
    expect(isGenerationAction("trim_video")).toBe(false);
  });

  it("keeps earlier GPT image history readable without exposing render tools", () => {
    const retired = RETIRED_GENERATION_ACTIONS.filter((action) => action.canonical_name.includes("gpt_image"));
    expect(retired).toHaveLength(2);
    const names = getAllToolDefs(scopedEngine).map((tool) => tool.name);
    for (const action of retired) {
      expect(names).not.toContain(action.canonical_name);
      expect(GENERATION_ACTIONS).not.toContain(action);
      for (const alias of action.legacy_names) expect(getActionSpec(alias)).toBe(action);
    }
  });

  it("keeps provider identity in provider-backed canonical names", () => {
    for (const spec of GENERATION_ACTIONS) {
      if (spec.provider === "workflow") continue;
      expect(spec.canonical_name).toMatch(new RegExp(`^(generate|extend|upscale)_${spec.provider}_`));
    }
    expect(getCanonicalName("generate_veo31_video")).toBe("generate_google_flow_veo_3_1_quality_video");
  });

  it("exposes each canonical tool exactly once and no historical aliases", () => {
    const names = getAllToolDefs(scopedEngine).map((tool) => tool.name);
    const registered = new Set(names);
    const canonical = new Set(GENERATION_ACTIONS.map((action) => action.canonical_name));

    expect(names).toHaveLength(315);
    expect(registered.size).toBe(names.length);
    for (const action of GENERATION_ACTIONS) {
      expect(registered.has(action.canonical_name), action.canonical_name).toBe(true);
      for (const legacyName of action.legacy_names) {
        if (!canonical.has(legacyName)) {
          expect(registered.has(legacyName), legacyName).toBe(false);
        }
      }
    }
  });
});
