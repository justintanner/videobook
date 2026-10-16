import { scopedEngine } from "../engine.js";
import { describe, it, expect } from "vitest";
import { getAllToolDefs } from "./index.js";

describe("support generation actions contract", () => {
  const registeredNames = new Set(getAllToolDefs(scopedEngine).map((tool) => tool.name));

  it("registers the canonical workflow support actions", () => {
    for (const name of [
      "inspect_generation_request",
      "reconcile_project_work",
      "clean_failed_assets",
      "retry_generation",
      "extend_audio_asset",
      "list_generation_models",
    ]) {
      expect(registeredNames.has(name), name).toBe(true);
    }
  });

  it("exposes neither retired support tools nor historical aliases", () => {
    for (const name of [
      "prepare_video_generation",
      "prepare_image_generation",
      "build_generation_provider_payload",
      "generate_image_model_comparison",
      "preview_video",
      "preview_image",
      "generation_payload",
      "translate_payload",
      "gen_images_all_models",
      "sync",
      "clear_failed_tasks",
      "extend_audio",
    ]) {
      expect(registeredNames.has(name), name).toBe(false);
    }
  });
});
