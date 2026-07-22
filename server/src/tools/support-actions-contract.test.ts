import { describe, it, expect } from "vitest";
import { GENERATION_ACTIONS, getCanonicalName, getActionSpec } from "../generation-registry.js";
import { getAllToolDefs } from "./index.js";
import { createFs } from "videocity-engine";

describe("support generation actions contract", () => {
  it("verifies all workflow support actions have intent-based canonical names", () => {
    const supportActions = GENERATION_ACTIONS.filter((a) => a.provider === "workflow");
    expect(supportActions.length).toBe(9);

    const expectedMappings: Record<string, string> = {
      preview_video: "prepare_video_generation",
      preview_image: "prepare_image_generation",
      generation_payload: "inspect_generation_request",
      translate_payload: "build_generation_provider_payload",
      gen_images_all_models: "generate_image_model_comparison",
      sync: "reconcile_project_work",
      clear_failed_tasks: "clean_failed_assets",
      retry_generation: "retry_generation",
      extend_audio: "extend_audio_asset",
    };

    for (const [oldName, expectedCanonical] of Object.entries(expectedMappings)) {
      expect(getCanonicalName(oldName)).toBe(expectedCanonical);
      expect(getActionSpec(oldName)?.canonical_name).toBe(expectedCanonical);
    }
  });

  it("verifies registered tool defs contain both canonical names and legacy aliases for support actions", () => {
    const fs = createFs({ projectsDir: "/tmp/test-support-projects" });
    const tools = getAllToolDefs(fs);
    const registeredNames = new Set(tools.map((t) => t.name));

    const supportActions = GENERATION_ACTIONS.filter((a) => a.provider === "workflow");
    for (const action of supportActions) {
      expect(registeredNames.has(action.canonical_name)).toBe(true);
      expect(registeredNames.has(action.old_name)).toBe(true);
    }
  });
});
