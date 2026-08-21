import { describe, expect, it } from "vitest";
import { scopedEngine } from "./engine.js";
import {
  GENERATION_ACTIONS,
  RETIRED_GENERATION_ACTIONS,
  RETIRED_KLING_AND_SEEDANCE_TOOL_NAMES,
  getCanonicalName,
  isGenerationAction,
} from "./generation-registry.js";
import { DEFAULT_VIDEO_MODEL_KEY, VIDEO_MODELS, buildVideoRoutingPrompt } from "./video-models.js";
import { getAllToolDefs } from "./tools/index.js";
import { listNotebookActions } from "./notebook-action-catalog.js";
import {
  KLING_OMNI_IMAGE_TO_VIDEO_TOOL,
  KLING_OMNI_REFERENCE_TO_VIDEO_TOOL,
  KLING_OMNI_TEXT_TO_VIDEO_TOOL,
  KLING_OMNI_TRANSFORMATION_TOOL,
  inferKlingOmniMode,
  klingOmniToolForMode,
} from "./kling-omni.js";
import { renderCommandReference, renderGenerationNamingManifest } from "./command-reference.js";
import { getCanonicalCommands } from "./tools/commands.js";

describe("retired Kling and Seedance surfaces", () => {
  it("keeps retired names only as history aliases, not as registered tools", () => {
    const registered = new Set(getAllToolDefs(scopedEngine).map((tool) => tool.name));
    const live = new Set(GENERATION_ACTIONS.map((action) => action.canonical_name));
    expect(RETIRED_KLING_AND_SEEDANCE_TOOL_NAMES.length).toBeGreaterThan(0);
    for (const name of RETIRED_KLING_AND_SEEDANCE_TOOL_NAMES) {
      expect(registered.has(name), name).toBe(false);
      expect(live.has(name), name).toBe(false);
      expect(isGenerationAction(name), name).toBe(true);
      expect(getCanonicalName(name)).not.toBe(KLING_OMNI_TEXT_TO_VIDEO_TOOL);
    }
    expect(RETIRED_GENERATION_ACTIONS.map((action) => action.canonical_name)).toEqual(
      expect.arrayContaining([
        "generate_kie_kling_3_0_video",
        "generate_kie_kling_3_0_motion_control",
        "generate_kie_kling_3_0_turbo_video",
        "generate_kie_seedance_2_0_video",
        "generate_fal_kling_video_v3_pro_text_to_video",
        "generate_fal_seedance_2_0_text_to_video",
      ]),
    );
  });

  it("exposes Omni and Seedance 2.5 and hides retired names from picker, routing, catalogs, and docs", () => {
    const pickerTools = Object.values(VIDEO_MODELS).map((model) => model.tool_name);
    expect(pickerTools).toContain(KLING_OMNI_TEXT_TO_VIDEO_TOOL);
    expect(pickerTools).toContain("generate_kie_seedance_2_5_video");
    expect(DEFAULT_VIDEO_MODEL_KEY).toBe("seedance25");
    expect(VIDEO_MODELS[DEFAULT_VIDEO_MODEL_KEY].tool_name).toBe("generate_kie_seedance_2_5_video");
    expect(VIDEO_MODELS.kling30.label).toBe("Kling 3.0 Omni");

    const routing = buildVideoRoutingPrompt();
    expect(routing).toContain(KLING_OMNI_TEXT_TO_VIDEO_TOOL);
    expect(routing).toContain(KLING_OMNI_IMAGE_TO_VIDEO_TOOL);
    expect(routing).toContain(KLING_OMNI_REFERENCE_TO_VIDEO_TOOL);
    expect(routing).toContain(KLING_OMNI_TRANSFORMATION_TOOL);
    expect(routing).toContain("generate_kie_seedance_2_5_video");
    expect(routing).toContain("PREFER generate_kie_seedance_2_5_video");
    for (const name of RETIRED_KLING_AND_SEEDANCE_TOOL_NAMES) {
      expect(pickerTools.includes(name), name).toBe(false);
      expect(routing.includes(name), name).toBe(false);
    }

    const catalogTools = listNotebookActions().map((action) => action.tool);
    expect(catalogTools).toContain(KLING_OMNI_TEXT_TO_VIDEO_TOOL);
    expect(catalogTools).toContain("generate_kie_seedance_2_5_video");
    for (const name of RETIRED_KLING_AND_SEEDANCE_TOOL_NAMES) {
      expect(catalogTools.includes(name), name).toBe(false);
    }

    const docs = renderCommandReference(
      getAllToolDefs(scopedEngine),
      getCanonicalCommands(),
      GENERATION_ACTIONS,
    );
    const manifest = renderGenerationNamingManifest(GENERATION_ACTIONS);
    expect(docs).toContain(KLING_OMNI_TEXT_TO_VIDEO_TOOL);
    expect(docs).toContain("generate_kie_seedance_2_5_video");
    expect(manifest).toContain(KLING_OMNI_TRANSFORMATION_TOOL);
    for (const name of [
      "generate_kie_kling_3_0_video",
      "generate_kie_kling_3_0_motion_control",
      "generate_kie_seedance_2_0_video",
      "generate_fal_kling_video_v3_pro_text_to_video",
      "generate_fal_seedance_2_0_text_to_video",
    ]) {
      expect(docs.includes(name), name).toBe(false);
      expect(manifest.includes(name), name).toBe(false);
    }
  });

  it("switches Omni modes to the matching canonical tool", () => {
    expect(klingOmniToolForMode("text")).toBe(KLING_OMNI_TEXT_TO_VIDEO_TOOL);
    expect(klingOmniToolForMode("image")).toBe(KLING_OMNI_IMAGE_TO_VIDEO_TOOL);
    expect(klingOmniToolForMode("reference")).toBe(KLING_OMNI_REFERENCE_TO_VIDEO_TOOL);
    expect(klingOmniToolForMode("transformation")).toBe(KLING_OMNI_TRANSFORMATION_TOOL);
    expect(inferKlingOmniMode({ prompt: "hello" })).toBe("text");
    expect(inferKlingOmniMode({ image_refs: ["@img"] })).toBe("image");
    expect(inferKlingOmniMode({ video_refs: ["@vid"] })).toBe("reference");
    expect(inferKlingOmniMode({ image_refs: ["@img"], video_refs: ["@vid"] })).toBe("transformation");
  });
});
