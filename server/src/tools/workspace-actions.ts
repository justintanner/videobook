import { buildWorkspaceActionCatalog } from "../workspace-action-catalog.js";
import { getCanonicalCommands } from "./commands.js";
import type { ToolDef } from "./tool-def.js";

export function workspaceActionsDef(getTools: () => readonly ToolDef[]): ToolDef {
  return {
    name: "list_workspace_actions",
    description: "List discoverable workspace actions, typed inputs, supported surfaces, and the visible workflow for each endpoint.",
    scope: "global",
    schema: {},
    handler: async () => ({
      content: [{
        type: "text",
        text: JSON.stringify(buildWorkspaceActionCatalog(getTools(), getCanonicalCommands())),
      }],
    }),
  };
}
