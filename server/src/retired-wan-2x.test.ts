import { describe, expect, it } from "vitest";
import { scopedEngine } from "./engine.js";
import {
  GENERATION_ACTIONS,
  RETIRED_GENERATION_ACTIONS,
  RETIRED_WAN_2X_TOOL_NAMES,
  getActionSpec,
  getCanonicalName,
  isGenerationAction,
} from "./generation-registry.js";
import { VIDEO_MODELS, buildVideoRoutingPrompt } from "./video-models.js";
import { getImageModels } from "./image-models.js";
import { getAllToolDefs } from "./tools/index.js";
import { listNotebookActions } from "./notebook-action-catalog.js";
import { renderCommandReference, renderGenerationNamingManifest } from "./command-reference.js";
import { getCanonicalCommands } from "./tools/commands.js";

const RETIRED_WAN_2X_CANONICAL_NAMES = [
  "generate_kie_wan_2_7_text_to_video",
  "generate_kie_wan_2_7_image_to_video",
  "generate_kie_wan_2_7_edit_video",
  "generate_kie_wan_2_7_reference_to_video",
  "extend_kie_wan_2_7_video",
  "generate_kie_wan_2_7_text_to_image",
  "generate_kie_wan_2_7_pro_text_to_image",
  "generate_alibaba_wan_2_7_text_to_image",
  "generate_alibaba_wan_2_7_pro_text_to_image",
  "generate_alibaba_wan_2_7_video",
  "generate_fal_wan_2_7_text_to_image",
  "generate_fal_wan_2_7_edit_image",
  "generate_fal_wan_2_7_pro_text_to_image",
  "generate_fal_wan_2_7_pro_edit_image",
  "generate_fal_wan_2_7_text_to_video",
  "generate_fal_wan_2_7_image_to_video",
  "generate_fal_wan_2_7_reference_to_video",
  "generate_fal_wan_2_7_edit_video",
];

describe("retired Wan 2.x surfaces", () => {
  it("keeps retired names only as history aliases, not as registered tools", () => {
    const registered = new Set(getAllToolDefs(scopedEngine).map((tool) => tool.name));
    const live = new Set(GENERATION_ACTIONS.map((action) => action.canonical_name));
    expect(RETIRED_WAN_2X_TOOL_NAMES.length).toBeGreaterThan(0);
    for (const name of RETIRED_WAN_2X_TOOL_NAMES) {
      expect(registered.has(name), name).toBe(false);
      expect(live.has(name), name).toBe(false);
      expect(isGenerationAction(name), name).toBe(true);
      expect(RETIRED_WAN_2X_CANONICAL_NAMES.includes(getCanonicalName(name)), name).toBe(true);
    }
    expect(RETIRED_GENERATION_ACTIONS.map((action) => action.canonical_name)).toEqual(
      expect.arrayContaining(RETIRED_WAN_2X_CANONICAL_NAMES),
    );
    expect(
      RETIRED_GENERATION_ACTIONS.filter((action) => RETIRED_WAN_2X_CANONICAL_NAMES.includes(action.canonical_name)),
    ).toHaveLength(18);
  });

  it("keeps persisted wan27 history readable through the retired specs", () => {
    const video = getActionSpec("generate_wan27_i2v_video");
    expect(video?.canonical_name).toBe("generate_kie_wan_2_7_image_to_video");
    expect(video?.job_task_discriminator).toBe("wan27_video_gen");
    expect(video?.persisted_history_consumers).toEqual(
      expect.arrayContaining(["notebook", "prompt_history", "project_activity"]),
    );
    const alibaba = getActionSpec("generate_alibaba_image");
    expect(alibaba?.canonical_name).toBe("generate_alibaba_wan_2_7_text_to_image");
    expect(alibaba?.persisted_history_consumers).toEqual(
      expect.arrayContaining(["notebook", "prompt_history", "project_activity"]),
    );
    const fal = getActionSpec("generate_wan27_videoedit_fal");
    expect(fal?.canonical_name).toBe("generate_fal_wan_2_7_edit_video");
  });

  it("hides retired names from pickers, routing, catalogs, and docs", () => {
    const pickerTools = [
      ...Object.values(VIDEO_MODELS).map((model) => model.tool_name),
      ...Object.values(getImageModels()).map((model) => model.tool_name),
    ];
    const routing = buildVideoRoutingPrompt();
    const catalogTools = listNotebookActions().map((action) => action.tool);
    const docs = renderCommandReference(
      getAllToolDefs(scopedEngine),
      getCanonicalCommands(),
      GENERATION_ACTIONS,
    );
    const manifest = renderGenerationNamingManifest(GENERATION_ACTIONS);
    for (const name of RETIRED_WAN_2X_TOOL_NAMES) {
      expect(pickerTools.includes(name), name).toBe(false);
      expect(routing.includes(name), name).toBe(false);
      expect(catalogTools.includes(name), name).toBe(false);
      expect(docs.includes(name), name).toBe(false);
      expect(manifest.includes(name), name).toBe(false);
    }
  });
});
