import { describe, expect, it } from "vitest";
import type { NotebookDocument } from "videobook-engine";
import { resolveModel } from "../../server/src/media/descriptor.js";
import {
  notebookGenerationInputContract,
  notebookGenerationInputsAreCompatible,
} from "../../server/src/notebook-generation-contract.js";

function contractFor(model: string) {
  return notebookGenerationInputContract(resolveModel(model));
}

const REPLACE_AUDIO_SLOT = {
  field: "replace_audio",
  kind: "audio",
  targets: ["replace_audio"],
  min: 0,
  max: 1,
};

describe("notebook generation input contracts", () => {
  it("reads media kinds and slot limits from apicity schemas", () => {
    expect(contractFor("kie:qwen3/image-to-image")).toEqual({
      modes: [{
        id: "default",
        slots: [{
          field: "image",
          kind: "image",
          targets: ["image"],
          min: 1,
          max: 3,
        }],
        requiredGroups: [],
      }],
    });
    expect(contractFor("elevenlabs:text-to-speech")).toEqual({
      modes: [{ id: "default", slots: [], requiredGroups: [] }],
    });
  });

  it("publishes Kling 3.0 Motion Control character and motion inputs", () => {
    expect(contractFor("kie:kling-3.0/motion-control")).toEqual({
      modes: [{
        id: "default",
        slots: [
          {
            field: "image",
            kind: "image",
            targets: ["image"],
            min: 1,
            max: 1,
          },
          {
            field: "video",
            kind: "video",
            targets: ["video"],
            min: 1,
            max: null,
          },
          REPLACE_AUDIO_SLOT,
        ],
        requiredGroups: [],
      }],
    });
  });

  it("publishes Kling Omni transformation image and video requirements", () => {
    const video = { field: "video", kind: "video", targets: ["video"], min: 1, max: 1 };
    expect(contractFor("kie:kling-3.0-omni/transformation")).toEqual({
      modes: [
        { id: "v2v", slots: [video, REPLACE_AUDIO_SLOT], requiredGroups: [["video"]] },
        {
          id: "v2v_refs",
          slots: [{ field: "image", kind: "image", targets: ["image"], min: 0, max: 4 }, video, REPLACE_AUDIO_SLOT],
          requiredGroups: [["video"]],
        },
      ],
    });
  });

  it("keeps Seedance frame and reference modes exclusive", () => {
    const contract = contractFor("kie:bytedance/seedance-2-5");
    expect(contract.modes.map((mode) => mode.id)).toEqual([
      "t2v",
      "i2v",
      "r2v",
    ]);
    expect(contract.modes.find((mode) => mode.id === "i2v")?.slots
      .map((slot) => slot.field)).toEqual([
      "first_frame",
      "last_frame",
      "replace_audio",
    ]);
    expect(contract.modes.find((mode) => mode.id === "r2v")?.slots
      .map((slot) => slot.field)).toEqual([
      "image",
      "video",
      "audio",
      "replace_audio",
    ]);
  });

  it("publishes Seedance 2.5 expanded multimodal slots", () => {
    const references = contractFor("kie:bytedance/seedance-2-5").modes
      .find((mode) => mode.id === "r2v");
    expect(references?.slots.map((slot) => ({
      field: slot.field,
      max: slot.max,
    }))).toEqual([
      { field: "image", max: 30 },
      { field: "video", max: 10 },
      { field: "audio", max: 10 },
      { field: "replace_audio", max: 1 },
    ]);
    expect(references?.requiredGroups).toEqual([["image", "video", "audio"]]);
  });


  it("publishes Kie Gemini image and video modes", () => {
    const contract = contractFor("kie:gemini-omni-video");
    expect(contract.modes.map((mode) => ({
      id: mode.id,
      fields: mode.slots.map((slot) => slot.field),
      requiredGroups: mode.requiredGroups,
    }))).toEqual([
      { id: "i2v", fields: ["image", "replace_audio"], requiredGroups: [] },
      { id: "v2v", fields: ["image", "video", "replace_audio"], requiredGroups: [["video"]] },
    ]);
  });

  it.each([
    "kie:wan/3-0-video",
    "kie:wan/3-0-video-prime",
  ])("keeps %s frame and reference modes exclusive", (model) => {
    const contract = contractFor(model);
    expect(contract.modes.map((mode) => ({
      id: mode.id,
      fields: mode.slots.map((slot) => slot.field),
    }))).toEqual([
      { id: "t2v", fields: ["replace_audio"] },
      { id: "i2v", fields: ["first_frame", "last_frame", "replace_audio"] },
      { id: "r2v", fields: ["image", "video", "audio", "replace_audio"] },
    ]);

    const source = {
      id: "01900000-0000-7000-8000-000000000001",
      type: "image" as const,
      slot: { row: 0, column: 0 },
    };
    const last = {
      id: "01900000-0000-7000-8000-000000000002",
      type: "image" as const,
      slot: { row: 0, column: 1 },
    };
    const generate = {
      id: "01900000-0000-7000-8000-000000000003",
      type: "generate_video" as const,
      slot: { row: 1, column: 0 },
    };
    const document: NotebookDocument = {
      id: "01900000-0000-7000-8000-000000000004",
      name: "Wan frames",
      cells: [source, last, generate],
      edges: [
        {
          id: "01900000-0000-7000-8000-000000000005",
          source: source.id,
          target: generate.id,
          targetInput: "image",
        },
        {
          id: "01900000-0000-7000-8000-000000000006",
          source: last.id,
          target: generate.id,
          targetInput: "last_frame",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(notebookGenerationInputsAreCompatible(
      contract,
      document,
      generate,
      "default",
    )).toBe(true);
    expect(notebookGenerationInputsAreCompatible(
      contract,
      document,
      generate,
      "i2v",
    )).toBe(true);
    expect(notebookGenerationInputsAreCompatible(
      contract,
      document,
      generate,
      "r2v",
    )).toBe(true);
  });
});
