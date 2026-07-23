import { describe, it, expect } from "vitest";
import { VIDEO_MODELS, getVideoToolSchema } from "../video-models.js";
import { getImageModels, getImageToolSchema } from "../image-models.js";
import { getAllToolDefs } from "./index.js";
import { createFs } from "videobook-engine";
import { getCanonicalName } from "../generation-registry.js";
import { GENERATION_ACTIONS } from "../generation-registry.js";

describe("schema parity between pickers and tool definitions", () => {
  const fs = createFs({ projectsDir: "/tmp/test-parity" });
  const tools = getAllToolDefs(fs);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  it("checks parity for all VIDEO_MODELS", () => {
    for (const [key, info] of Object.entries(VIDEO_MODELS)) {
      const canonicalName = getCanonicalName(info.tool_name);
      const toolDef = toolMap.get(canonicalName) ?? toolMap.get(info.tool_name);
      expect(toolDef).toBeDefined();

      const pickerSchema = getVideoToolSchema(key);
      const executionShape = toolDef!.schema;

      const pickerKeys = new Set(Object.keys(pickerSchema?.properties ?? {}));
      const executionKeys = new Set(Object.keys(executionShape));

      // Internal fields injected during execution: project_slug, _provider
      const internalFields = new Set(["project_slug", "_provider", "asset_id"]);

      for (const pKey of pickerKeys) {
        if (!internalFields.has(pKey)) {
          expect(executionKeys.has(pKey)).toBe(true);
        }
      }
    }
  });

  it("checks parity for all getImageModels()", () => {
    const imageModels = Object.values(getImageModels());
    for (const model of imageModels) {
      const canonicalName = getCanonicalName(model.tool_name);
      const toolDef = toolMap.get(canonicalName) ?? toolMap.get(model.tool_name);
      expect(toolDef).toBeDefined();

      const pickerSchema = getImageToolSchema(model.tool_name);
      const executionShape = toolDef!.schema;

      const pickerKeys = new Set(Object.keys(pickerSchema?.properties ?? {}));
      const executionKeys = new Set(Object.keys(executionShape));

      const internalFields = new Set(["project_slug", "_provider"]);

      for (const pKey of pickerKeys) {
        if (!internalFields.has(pKey)) {
          expect(executionKeys.has(pKey)).toBe(true);
        }
      }
    }
  });

  it("keeps picker schemas resolvable through historical names", () => {
    for (const action of GENERATION_ACTIONS) {
      if (action.media_type === "video") {
        const canonical = getVideoToolSchema(action.canonical_name);
        for (const legacyName of action.legacy_names) {
          expect(getVideoToolSchema(legacyName), legacyName).toEqual(canonical);
        }
      }
      if (action.media_type === "image") {
        const canonical = getImageToolSchema(action.canonical_name);
        for (const legacyName of action.legacy_names) {
          expect(getImageToolSchema(legacyName), legacyName).toEqual(canonical);
        }
      }
    }
  });
});
