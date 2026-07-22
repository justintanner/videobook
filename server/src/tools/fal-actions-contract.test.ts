import { describe, it, expect } from "vitest";
import { GENERATION_ACTIONS, getCanonicalName, getActionSpec } from "../generation-registry.js";
import { getAllToolDefs } from "./index.js";
import { createFs } from "videocity-engine";

describe("fal generation actions contract", () => {
  it("verifies all 36 Fal generation actions have canonical names and exact endpoint IDs", () => {
    const falActions = GENERATION_ACTIONS.filter((a) => a.provider === "fal");
    expect(falActions.length).toBe(36);

    for (const action of falActions) {
      expect(action.canonical_name).toMatch(/^generate_fal_|^extend_fal_/);
      expect(action.apicity_identifier).toMatch(/^fal-ai\//);
      expect(action.canonical_name).not.toMatch(/_t2i_/);
      expect(action.canonical_name).not.toMatch(/_i2v_/);
      expect(action.canonical_name).not.toMatch(/_r2v_/);
      expect(action.canonical_name).not.toMatch(/_fal$/);

      // Verify alias resolves to canonical
      expect(getCanonicalName(action.old_name)).toBe(action.canonical_name);
      expect(getActionSpec(action.old_name)?.apicity_identifier).toBe(action.apicity_identifier);
    }
  });

  it("verifies registered tool defs contain both canonical names and legacy aliases for all Fal actions", () => {
    const fs = createFs({ projectsDir: "/tmp/test-fal-projects" });
    const tools = getAllToolDefs(fs);
    const registeredNames = new Set(tools.map((t) => t.name));

    const falActions = GENERATION_ACTIONS.filter((a) => a.provider === "fal");
    for (const action of falActions) {
      expect(registeredNames.has(action.canonical_name)).toBe(true);
      expect(registeredNames.has(action.old_name)).toBe(true);
    }
  });
});
