import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scopedEngine } from "../engine.js";
import { GENERATION_ACTIONS } from "../generation-registry.js";
import { buildWorkspaceActionCatalog } from "../workspace-action-catalog.js";
import type { WorkspaceActionCatalog } from "../workspace-action-contract.js";
import { getCanonicalCommands } from "./commands.js";
import { getAllToolDefs } from "./index.js";
import { WORKSPACE_ACTION_SURFACES } from "../workspace-action-surfaces.js";
import { WORKSPACE_UI_ROUTES } from "../../../src/videobook/workspace-ui-routes.js";
import { renderWorkspaceActionCoverage } from "../command-reference.js";

describe("workspace action exposure contract", () => {
  const tools = getAllToolDefs(scopedEngine);
  const commands = getCanonicalCommands();

  it("accounts for every endpoint and every canonical command through its registered catalog handler", async () => {
    const definition = tools.find((tool) => tool.name === "list_workspace_actions")!;
    const result = await definition.handler({});
    expect(result.isError).toBeUndefined();
    const catalog = JSON.parse(result.content[0]!.text) as WorkspaceActionCatalog;
    const names = catalog.actions.flatMap((action) => [action.command, ...action.aliases]);
    const ids = catalog.actions.map((action) => action.id);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(catalog.tools.map((entry) => entry.tool).sort()).toEqual(tools.map((tool) => tool.name).sort());
    for (const command of commands) {
      expect(names, command.command).toEqual(expect.arrayContaining([command.command, ...(command.aliases ?? [])]));
    }
    for (const entry of catalog.tools) {
      expect(ids, entry.tool).toContain(entry.actionId);
      expect(entry.reason.trim().length, entry.tool).toBeGreaterThan(0);
    }
    for (const action of GENERATION_ACTIONS) {
      expect(catalog.tools.map((entry) => entry.tool), action.canonical_name).toContain(action.canonical_name);
    }
  });

  it("preserves real nested schemas and distinct command presets across repeated reads", () => {
    const original = structuredClone(commands);
    const first = buildWorkspaceActionCatalog(tools, commands);
    const second = buildWorkspaceActionCatalog(tools, commands);
    expect(first).toEqual(second);
    expect(commands).toEqual(original);
    const crop = first.actions.find((action) => action.id === "tool.crop_image")!;
    expect(crop.inputSchema.properties?.ratio?.enum).toEqual(["16:9", "9:16", "1:1"]);
    expect(crop.inputSchema.properties?.x).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(crop.target).toEqual({ kind: "asset", argument: "asset_id", mediaKinds: ["image"] });
    expect(first.actions.find((action) => action.command === "/rewrite-script")?.initialArgs).toEqual({ variant: "full" });
    expect(first.actions.find((action) => action.command === "/tldr")?.initialArgs).toEqual({ variant: "tldr" });
    expect(first.actions.find((action) => action.command === "/clip-audio")?.inputSchema.properties?.field?.enum)
      .toEqual(["gain", "mute", "fade-in", "fade-out"]);
    const edit = first.actions.find((action) => action.id === "tool.plan_sequence_edit")!;
    expect(edit.inputSchema.properties?.request?.anyOf).toBeDefined();
  });

  it("rejects new unmapped capabilities, missing handlers and alias collisions", () => {
    const source = tools.find((tool) => tool.name === "list_books")!;
    expect(() => buildWorkspaceActionCatalog([...tools, { ...source, name: "new_user_operation" }], commands))
      .toThrow("No workspace action group for new_user_operation");
    expect(() => buildWorkspaceActionCatalog(tools.filter((tool) => tool.name !== "trim_video"), commands))
      .toThrow("No registered handler for /trim-video");
    expect(() => buildWorkspaceActionCatalog(tools, [...commands, { ...commands[0]!, command: "/custom", aliases: ["/trim"] }]))
      .toThrow("Duplicate workspace command or alias: /trim");
    expect(() => buildWorkspaceActionCatalog(tools, [...commands, { ...commands[0]!, command: "/custom", aliases: [], uiAction: "missing_handler" }]))
      .toThrow("No UI action handler contract");
  });

  it("rejects schemas that cannot be faithfully represented as action inputs", () => {
    const unsupported = tools.map((tool) => tool.name === "create_book"
      ? { ...tool, schema: { ...tool.schema, callback: z.function() } }
      : tool);
    expect(() => buildWorkspaceActionCatalog(unsupported, commands)).toThrow();
  });

  it("binds declared surfaces and UI routes to their components and registered tools", () => {
    const catalog = buildWorkspaceActionCatalog(tools, commands);
    const registered = new Set(tools.map((tool) => tool.name));
    for (const [name, surface] of Object.entries(WORKSPACE_ACTION_SURFACES)) {
      const source = readFileSync(resolve(import.meta.dirname, "../../..", surface.component), "utf8");
      expect(source, name).toContain("data-workspace-action-surface");
      expect(source, name).toMatch(new RegExp(`["']${name}["']`, "u"));
    }
    for (const action of catalog.actions) {
      if (action.handler.kind !== "ui") continue;
      const route = WORKSPACE_UI_ROUTES[action.handler.action];
      expect(route, action.id).toBeDefined();
      if (route.kind === "form") expect(registered.has(route.tool), action.id).toBe(true);
    }
    expect(() => buildWorkspaceActionCatalog(tools, commands, new Set(["slash", "launcher", "button"]))).toThrow("No implemented surface");
    expect(readFileSync(resolve(import.meta.dirname, "../../../docs/action-coverage.md"), "utf8")).toBe(renderWorkspaceActionCoverage(catalog));
  });
});
