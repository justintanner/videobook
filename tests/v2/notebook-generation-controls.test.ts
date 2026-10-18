import { describe, expect, it } from "vitest";
import { controlsForModel, notebookGenerationControls } from "../../server/src/notebook-generation-controls.js";
import { resolveModel } from "../../server/src/media/descriptor.js";
import { buildWireRequest } from "../../server/src/media/request.js";

describe("notebook generation controls", () => {
  it("exposes nullable sound-effect duration and influence as bounded numeric controls", () => {
    const model = resolveModel("elevenlabs:sound-generation");
    const controls = controlsForModel(model);
    expect(controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "duration_seconds", kind: "number", valueType: "number", minimum: 0.5, maximum: 30, required: false }),
      expect.objectContaining({ name: "prompt_influence", kind: "number", valueType: "number", minimum: 0, maximum: 1, required: false }),
    ]));
    expect(buildWireRequest(model, { prompt: "Woodworking ambience", options: { duration_seconds: "28.06", prompt_influence: "0.3" } }))
      .toMatchObject({ ok: true, request: { duration_seconds: 28.06, prompt_influence: 0.3 } });
    expect(buildWireRequest(model, { prompt: "A tap", options: { duration_seconds: null } }))
      .toMatchObject({ ok: true, request: { duration_seconds: null } });
  });

  it("serializes primitive model settings and omits connection-owned fields", () => {
    expect(notebookGenerationControls({
      properties: {
        prompt: { type: "string" },
        character_image_slugs: { type: "array" },
        image_slugs: { type: "array" },
        motion_video_slugs: { type: "array" },
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

  it("keeps an exclusive numeric bound", () => {
    expect(notebookGenerationControls({
      properties: {
        resume_time: {
          type: "number",
          minimum: 1.625,
          exclusiveMinimum: true,
          maximum: 60,
          description: "Resume time",
        },
      },
      required: ["resume_time"],
    })[0]).toMatchObject({
      name: "resume_time",
      required: true,
      minimum: 1.625,
      exclusiveMinimum: true,
      maximum: 60,
    });
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
