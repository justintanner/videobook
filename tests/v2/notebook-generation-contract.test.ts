import { describe, expect, it } from "vitest";
import { z } from "zod";
import { notebookGenerationInputContract } from "../../server/src/notebook-generation-contract.js";

describe("notebook generation input contracts", () => {
  it("reads media kinds and slot limits from registered-style schemas", () => {
    expect(notebookGenerationInputContract("generate_test", {
      image_refs: z.array(z.string()).min(1).max(3),
      video_ref: z.string().optional(),
      audio_ref: z.string(),
    })).toEqual({
      modes: [{
        id: "default",
        slots: [
          {
            field: "image_refs",
            kind: "image",
            targets: ["image"],
            min: 1,
            max: 3,
          },
          {
            field: "video_ref",
            kind: "video",
            targets: ["video"],
            min: 0,
            max: 1,
          },
          {
            field: "audio_ref",
            kind: "audio",
            targets: ["audio"],
            min: 1,
            max: 1,
          },
        ],
        requiredGroups: [],
      }],
    });
  });

  it("publishes Kling motion control image and video requirements", () => {
    expect(notebookGenerationInputContract(
      "generate_kie_kling_3_0_motion_control",
      {
        character_image_refs: z.array(z.string()).min(1).max(1),
        motion_video_refs: z.array(z.string()).min(1).max(1),
      },
    )).toEqual({
      modes: [{
        id: "default",
        slots: [
          {
            field: "character_image_refs",
            kind: "image",
            targets: ["image"],
            min: 1,
            max: 1,
          },
          {
            field: "motion_video_refs",
            kind: "video",
            targets: ["video"],
            min: 1,
            max: 1,
          },
        ],
        requiredGroups: [],
      }],
    });
  });

  it("keeps Seedance frame and reference modes exclusive", () => {
    const contract = notebookGenerationInputContract(
      "generate_kie_seedance_2_0_video",
      {
        first_frame_ref: z.string().optional(),
        last_frame_ref: z.string().optional(),
        image_refs: z.array(z.string()).max(9).optional(),
        video_refs: z.array(z.string()).max(3).optional(),
        audio_refs: z.array(z.string()).max(3).optional(),
        replace_audio_with: z.string().optional(),
      },
    );
    expect(contract.modes.map((mode) => mode.id)).toEqual([
      "t2v",
      "i2v",
      "r2v",
    ]);
    expect(contract.modes.find((mode) => mode.id === "i2v")?.slots
      .map((slot) => slot.field)).toEqual([
      "first_frame_ref",
      "last_frame_ref",
      "replace_audio_with",
    ]);
    expect(contract.modes.find((mode) => mode.id === "r2v")?.slots
      .map((slot) => slot.field)).toEqual([
      "image_refs",
      "video_refs",
      "audio_refs",
      "replace_audio_with",
    ]);
  });

  it("publishes Seedance 2.5 expanded multimodal slots", () => {
    const contract = notebookGenerationInputContract(
      "generate_kie_seedance_2_5_video",
      {
        first_frame_ref: z.string().optional(),
        last_frame_ref: z.string().optional(),
        image_refs: z.array(z.string()).max(30).optional(),
        video_refs: z.array(z.string()).max(10).optional(),
        audio_refs: z.array(z.string()).max(10).optional(),
      },
    );
    const references = contract.modes.find((mode) => mode.id === "r2v");
    expect(references?.slots.map((slot) => ({
      field: slot.field,
      max: slot.max,
    }))).toEqual([
      { field: "image_refs", max: 30 },
      { field: "video_refs", max: 10 },
      { field: "audio_refs", max: 10 },
    ]);
  });

  it("publishes Google Omni modes with their required input roles", () => {
    const contract = notebookGenerationInputContract(
      "generate_google_flow_omni_flash_video",
      {
        first_frame_ref: z.string().optional(),
        image_refs: z.array(z.string()).max(7).optional(),
        video_ref: z.string().optional(),
      },
    );
    expect(contract.modes.map((mode) => ({
      id: mode.id,
      requiredGroups: mode.requiredGroups,
    }))).toEqual([
      { id: "t2v", requiredGroups: [] },
      { id: "i2v", requiredGroups: [["first_frame_ref"]] },
      { id: "r2v", requiredGroups: [["image_refs"]] },
      { id: "v2v", requiredGroups: [["video_ref"]] },
    ]);
  });

  it("publishes Kie Gemini text, reference, and video modes", () => {
    const contract = notebookGenerationInputContract(
      "generate_kie_gemini_omni_video",
      {
        image_refs: z.array(z.string()).max(7).optional(),
        video_ref: z.string().optional(),
      },
    );
    expect(contract.modes.map((mode) => ({
      id: mode.id,
      requiredGroups: mode.requiredGroups,
    }))).toEqual([
      { id: "t2v", requiredGroups: [] },
      { id: "r2v", requiredGroups: [["image_refs"]] },
      { id: "v2v", requiredGroups: [["video_ref"]] },
    ]);
  });
});
