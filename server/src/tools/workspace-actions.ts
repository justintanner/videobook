import { z } from "zod";
import { buildWorkspaceActionCatalog } from "../workspace-action-catalog.js";
import type { ActionGroup, WorkspaceAction } from "../workspace-action-contract.js";
import { WORKSPACE_TOOL_GROUPS } from "../workspace-action-groups.js";
import { getCanonicalCommands } from "./commands.js";
import type { ToolDef } from "./tool-def.js";

type ActionSelection = { query?: string; group?: ActionGroup; ids?: string[] };

const ACTION_GROUPS = Object.keys(WORKSPACE_TOOL_GROUPS) as [ActionGroup, ...ActionGroup[]];

function handlerName(action: WorkspaceAction): string {
  switch (action.handler.kind) {
    case "tool": return `tool:${action.handler.tool}`;
    case "ui": return `ui:${action.handler.action}`;
    case "command": return `command:${action.handler.command}`;
  }
}

function actionSummary(action: WorkspaceAction) {
  return {
    id: action.id,
    command: action.command,
    title: action.title,
    group: action.group,
    runs: handlerName(action),
  };
}

function matchesQuery(action: WorkspaceAction, terms: readonly string[]): boolean {
  const text = [action.title, action.command, action.description, action.group, ...action.aliases, ...action.keywords]
    .join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}

function selectActions(actions: readonly WorkspaceAction[], selection: ActionSelection): WorkspaceAction[] {
  const terms = (selection.query ?? "").trim().toLowerCase().replace(/^\//u, "").split(/\s+/u).filter(Boolean);
  const ids = selection.ids ? new Set(selection.ids) : null;
  return actions.filter((action) => (!ids || ids.has(action.id))
    && (!selection.group || action.group === selection.group)
    && matchesQuery(action, terms));
}

export function workspaceActionsDef(getTools: () => readonly ToolDef[]): ToolDef {
  return {
    name: "list_workspace_actions",
    description: "List workspace actions (tools, app screens and composite commands) as id, command, title, group and what each runs. Filter with query, group or ids; detail full adds typed inputs, surfaces, confirmation policy and tool coverage.",
    scope: "global",
    schema: {
      query: z.string().optional().describe("Words that must all appear in an action's title, command, description or keywords"),
      group: z.enum(ACTION_GROUPS).optional(),
      ids: z.array(z.string()).optional().describe("Action ids such as tool.trim_video or command.goal"),
      detail: z.enum(["summary", "full"]).optional(),
    },
    handler: async (args) => {
      const catalog = buildWorkspaceActionCatalog(getTools(), getCanonicalCommands());
      const actions = selectActions(catalog.actions, args as ActionSelection);
      const payload = args.detail === "full"
        ? { actions, tools: catalog.tools }
        : { actions: actions.map(actionSummary) };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  };
}
