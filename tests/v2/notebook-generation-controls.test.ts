import { describe, expect, it } from "vitest";
import { notebookGenerationControls } from "../../server/src/notebook-generation-controls.js";

describe("notebook generation controls", () => {
  it("serializes primitive model settings and omits connection-owned fields", () => {
    expect(notebookGenerationControls({
      properties: {
        prompt: { type: "string" },
        image_slugs: { type: "array" },
        aspect_ratio: {
          type: "string",
          enum: ["16:9", "9:16"],
          description: "Output aspect ratio",
        },
        duration: { type: "integer", minimum: 4, maximum: 10 },
        generate_audio: { type: "boolean", default: true },
        negative_prompt: { type: "string" },
      },
      required: ["prompt", "duration"],
      defaults: { aspect_ratio: "16:9" },
    })).toEqual([
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        kind: "select",
        valueType: "string",
        required: false,
        defaultValue: "16:9",
        options: ["16:9", "9:16"],
        description: "Output aspect ratio",
      },
      {
        name: "duration",
        label: "Duration",
        kind: "number",
        valueType: "number",
        required: true,
        minimum: 4,
        maximum: 10,
        description: "Duration",
      },
      {
        name: "generate_audio",
        label: "Generate audio",
        kind: "boolean",
        valueType: "boolean",
        required: false,
        defaultValue: true,
        description: "Generate audio",
      },
      {
        name: "negative_prompt",
        label: "Negative prompt",
        kind: "text",
        valueType: "string",
        required: false,
        description: "Negative prompt",
      },
    ]);
  });

  it("applies notebook-specific defaults", () => {
    expect(notebookGenerationControls({
      properties: {
        duration: { type: "string", enum: ["4", "6", "8", "10"] },
      },
      required: ["duration"],
    }, { duration: "8" })[0]).toMatchObject({
      name: "duration",
      defaultValue: "8",
    });
  });
});
