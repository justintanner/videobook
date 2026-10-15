import { z } from "zod";
import { GENERATION_ACTIONS } from "./generation-registry.js";
import { WORKSPACE_TOOL_GROUPS } from "./workspace-action-groups.js";
import { toolSpendsMoney } from "./paid-tools.js";
import { WORKSPACE_ACTION_SURFACES } from "./workspace-action-surfaces.js";
import { APPLICATION_COMMAND_IDS, UI_ACTION_IDS } from "./workspace-action-contract.js";
import type {
  ActionGroup,
  ActionInputSchema,
  ActionTarget,
  ApplicationCommandId,
  UiActionId,
  WorkspaceAction,
  WorkspaceActionCatalog,
} from "./workspace-action-contract.js";
import type { Command } from "./tools/video-editing-command-contract.js";
import type { ToolDef } from "./tools/tool-def.js";

const generationSpecs = new Map(GENERATION_ACTIONS.map((action) => [action.canonical_name, action]));
const toolGroups = new Map(Object.entries(WORKSPACE_TOOL_GROUPS).flatMap(([group, tools]) =>
  tools.map((tool) => [tool, group as ActionGroup] as const)));
const uiActions = new Set<string>(UI_ACTION_IDS);
const applicationCommands = new Set<string>(APPLICATION_COMMAND_IDS);

const workflowTools: Readonly<Record<string, { actionId: string; reason: string }>> = {
  upload_post_to_dropbox: { actionId: "command.upload-post-to-dropbox", reason: "Uploads after the composer review shows the Post, its editable caption and the destination folder." },
  save_post_to_icloud: { actionId: "command.save-post-to-icloud", reason: "Saves after the composer delivery sheet shows the Post, its caption and the iPhone folder." },
  prepare_cold_open: { actionId: "command.edit-cold-open", reason: "Selects a highlight in the cold-open review." },
  edit_cold_open: { actionId: "command.edit-cold-open", reason: "Creates the reviewed cold-open copy." },
  video_goal: {
    actionId: "command.goal",
    reason: "Goal mode defaults to portrait and Cinematic style. IG Influencer adds a hyper-realistic phone-shot style with content format, delivery, camera and light options, fixed after the frame. Review the plan and separately approve the frame, storyboards and videos; still versions remain selectable and revisable.",
  },
  assemble_goal: {
    actionId: "command.goal",
    reason: "Goal mode appends its completed shots to the sequence in order.",
  },
  list_workspace_actions: {
    actionId: "command.actions",
    reason: "Loads the Actions launcher and its typed forms.",
  },
  slash_commands: {
    actionId: "command.actions",
    reason: "Loads slash suggestions and dynamic project shortcuts in the Actions launcher.",
  },
  record_prompt: {
    actionId: "tool.chat",
    reason: "Records text entered through the composer and generation editors; browsing history is a separate action.",
  },
  push_chat_history: {
    actionId: "tool.chat",
    reason: "Compatibility write for composer history; users enter messages through chat.",
  },
  check_duplicate_bytes: {
    actionId: "command.upload",
    reason: "Checks existing immutable bytes during Import before uploading a file.",
  },
  upload_file: {
    actionId: "command.upload",
    reason: "Import opens a native file picker and uploads media through the file workflow; users do not enter base64 data.",
  },
};

function title(value: string): string {
  const words = value.replace(/^\//u, "").replaceAll(/[_-]/gu, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
    .replace(/\bqr\b/gu, "QR")
    .replace(/\bsfx\b/gu, "sound effects")
    .replace(/\bgf\b/gu, "Google Flow");
}

function groupForTool(name: string): ActionGroup {
  const group = toolGroups.get(name);
  if (group) return group;
  if (generationSpecs.has(name)) return "Generation";
  throw new Error(`No workspace action group for ${name}`);
}

function uiGroup(action: UiActionId): ActionGroup {
  if (/provider|gf_characters|x_connect/u.test(action)) return "Providers";
  if (/archive|diagnostic|storage|jobs|inbox/u.test(action)) return "Recovery";
  if (/histor|revision|status|rewind/u.test(action)) return "History";
  if (/entities/u.test(action)) return "Entities";
  if (/post/u.test(action)) return "Publishing";
  if (/timeline|music_video|slot_player/u.test(action)) return "Sequence";
  if (/notebook/u.test(action)) return "Notebook";
  if (/speak|audio/u.test(action)) return "Audio";
  if (/viewer|settings|watermark|cold_open|crop|osg|skeleton/u.test(action)) return "Video";
  if (/asset|clipboard|upload|rename/u.test(action)) return "Media";
  return "Workspace";
}

function targetForSchema(schema: ActionInputSchema, group: ActionGroup): ActionTarget {
  const fields = schema.properties ?? {};
  if (fields.cell_id) return { kind: "cell", argument: "cell_id" };
  if (fields.cell_ids) return { kind: "cell", argument: "cell_ids", multiple: true };
  if (fields.post_cell_id && schema.required?.includes("post_cell_id")) return { kind: "cell", argument: "post_cell_id" };
  if (fields.source_cell_id) return { kind: "cell", argument: "source_cell_id" };
  if (fields.clip_id) return { kind: "clip", argument: "clip_id" };
  if (fields.track_id) return { kind: "track", argument: "track_id" };
  const asset = ["asset_id", "asset_ref", "artifact_id", "artifact_ref", "audio_ref", "video_ref", "image_ref", "artifact_ids", "image_refs", "video_refs", "audio_refs", "qr_image_refs"]
    .find((name) => name in fields);
  if (asset) {
    const mediaKinds: ActionTarget["mediaKinds"] = /image/u.test(asset) ? ["image"] : /audio/u.test(asset) ? ["audio"] : /video/u.test(asset) ? ["video", "final"] : group === "Video"
      ? ["video", "final"]
      : group === "Audio"
        ? ["audio", "video", "final"]
        : group === "Images" ? ["image"] : undefined;
    return { kind: "asset", argument: asset, ...(asset.endsWith("s") ? { multiple: true } : {}), ...(mediaKinds ? { mediaKinds } : {}) };
  }
  if (fields.notebook_id) return { kind: "notebook", argument: "notebook_id" };
  return { kind: "none" };
}

function scopeForSchema(schema: ActionInputSchema): WorkspaceAction["scope"] {
  const required = new Set(schema.required ?? []);
  if (required.has("sequence_id")) return "sequence";
  if (required.has("notebook_id")) return "notebook";
  if (required.has("book_id")) return "book";
  return "global";
}

function confirmationForTool(tool: ToolDef): WorkspaceAction["confirmation"] {
  if (toolSpendsMoney(tool.name)) return "generation";
  if (["post", "storage_sync", "archive_clip"].includes(tool.name)) return "external";
  if (tool.name === "enqueue_sequence_export" || tool.annotations?.destructiveHint || /^(?:delete_|forget_|remove_|clean_failed|restore_)/u.test(tool.name)) {
    return "destructive";
  }
  return "none";
}

function commandSchema(command: Command): ActionInputSchema {
  const schema: ActionInputSchema = {
    type: "object",
    properties: Object.fromEntries(command.params.map((param) => [param.name, {
      type: param.type === "string[]" ? "array" : param.type,
      description: param.description,
      ...(param.type === "string[]" ? { items: { type: "string" } } : {}),
    }])),
    required: command.params.filter((param) => param.required).map((param) => param.name),
  };
  const fields = schema.properties ?? {};
  for (const [name, field] of Object.entries(fields)) {
    if (name.endsWith("_frame") || name.endsWith("_frames")) {
      field.type = "integer";
      field.minimum = name === "duration_frames" ? 1 : 0;
    }
    if (name === "gain_db") Object.assign(field, { minimum: -96, maximum: 24 });
    if (name === "reduction_db") Object.assign(field, { minimum: -36, maximum: -1, default: -12 });
  }
  if (command.command === "/track-add") fields.kind!.enum = ["video", "audio", "caption"];
  if (command.command === "/caption") fields.style!.enum = ["clean", "bold", "high-contrast"];
  if (command.command === "/fit") fields.mode!.enum = ["fit", "fill", "crop"];
  if (command.command === "/clip-audio") fields.field!.enum = ["gain", "mute", "fade-in", "fade-out"];
  if (command.command === "/clip-delete") fields.ripple!.enum = ["--ripple"];
  if (command.command === "/export-sequence") {
    Object.assign(fields.aspect!, { enum: ["16:9", "9:16", "1:1"], default: "16:9" });
    Object.assign(fields.captions!, { enum: ["burned", "sidecar", "omit"], default: "burned" });
  }
  if (command.command === "/crop") fields.ratio!.enum = ["16:9", "9:16", "1:1"];
  if (command.command === "/bg") fields.mode!.enum = ["blur", "black"];
  if (["/collapse", "/expand"].includes(command.command)) fields.side!.enum = ["left", "right", "both"];
  if (command.command === "/sort") fields.order!.enum = ["newest", "oldest"];
  return schema;
}

function uiCommandAction(command: Command): WorkspaceAction {
  const action = command.uiAction;
  if (!action || !uiActions.has(action)) throw new Error(`No UI action handler contract for ${command.command}: ${action}`);
  const group = uiGroup(action as UiActionId);
  const schema = commandSchema(command);
  if (["viewer_set_original", "viewer_set_landscape", "viewer_set_portrait", "viewer_focus_file", "viewer_show_settings", "settings_landscape", "settings_portrait", "settings_square", "settings_audio", "settings_subs", "settings_bg", "settings_osg"].includes(action)) {
    schema.properties = { asset_id: { type: "string", description: "Media to view or edit" }, ...schema.properties };
    schema.required = ["asset_id", ...(schema.required ?? [])];
  }
  const target = targetForSchema(schema, group);
  if (action === "open_crop" || ["viewer_set_original", "viewer_set_landscape", "viewer_set_portrait", "viewer_focus_file"].includes(action)) target.mediaKinds = ["image", "video", "final"];
  if (action === "extract_skeleton") target.mediaKinds = ["image"];
  return {
    id: `command.${command.command.slice(1)}`,
    title: title(command.command),
    description: command.description,
    group,
    command: command.command,
    aliases: [...(command.aliases ?? [])],
    keywords: [group, ...command.params.map((param) => param.description)],
    scope: ["open_projects", "open_provider_keys", "open_actions", "x_connect"].includes(action) ? "global" : "book",
    target,
    handler: { kind: "ui", action: action as UiActionId },
    inputSchema: schema,
    surfaces: ["slash", "launcher"],
    focus: /^(?:open_|show_|viewer_|settings_|speak_preview)/u.test(action) ? "dialog" : "composer",
    confirmation: "none",
  };
}

function applicationCommandAction(command: Command): WorkspaceAction {
  if (!applicationCommands.has(command.command)) throw new Error(`No application handler contract for ${command.command}`);
  const schema = commandSchema(command);
  const group = /arrange|group|split$|generate-cell/u.test(command.command) ? "Notebook" : "Sequence";
  return {
    id: `command.${command.command.slice(1)}`, title: title(command.command), description: command.description,
    group, command: command.command, aliases: [...(command.aliases ?? [])], keywords: [group],
    scope: group === "Notebook" ? "notebook" : "sequence", target: targetForSchema(schema, group),
    handler: { kind: "command", command: command.command as ApplicationCommandId }, inputSchema: schema,
    surfaces: ["slash", "launcher"], focus: "composer", confirmation: "none",
  };
}

function toolAction(tool: ToolDef, command: Command | undefined, reserved: Set<string>): WorkspaceAction {
  const group = groupForTool(tool.name);
  const schema = z.toJSONSchema(z.object(tool.schema), { io: "input" }) as ActionInputSchema;
  if (tool.name === "set_env_secret" && schema.properties?.value) schema.properties.value.format = "password";
  const preferredCommand = `/${tool.name.replaceAll("_", "-")}`;
  const name = command?.command ?? (reserved.has(preferredCommand) ? `/tool-${preferredCommand.slice(1)}` : preferredCommand);
  reserved.add(name);
  const target = targetForSchema(schema, group);
  const generation = generationSpecs.get(tool.name);
  return {
    id: `tool.${tool.name}`,
    title: tool.annotations?.title ?? title(tool.name),
    description: command?.description ?? tool.description,
    group,
    command: name,
    aliases: [...(command?.aliases ?? [])],
    keywords: [tool.name, group, ...(generation ? [generation.provider, generation.apicity_identifier] : [])],
    scope: scopeForSchema(schema),
    target,
    handler: { kind: "tool", tool: tool.name },
    inputSchema: schema,
    ...(command?.mcpTool?.injectParams ? { initialArgs: { ...command.mcpTool.injectParams } } : {}),
    ...(generation ? { generation: { provider: generation.provider, operation: generation.operation, mediaType: generation.media_type } } : {}),
    surfaces: target.kind === "asset" ? ["slash", "launcher", "cell-menu", "library-menu"]
      : target.kind === "cell" ? ["slash", "launcher", "cell-menu", "selection-menu"] : ["slash", "launcher"],
    focus: "dialog",
    confirmation: confirmationForTool(tool),
  };
}

export function buildWorkspaceActionCatalog(
  tools: readonly ToolDef[],
  commands: readonly Command[],
  surfaces: ReadonlySet<string> = new Set(Object.keys(WORKSPACE_ACTION_SURFACES)),
): WorkspaceActionCatalog {
  const reserved = new Set<string>();
  for (const command of commands) {
    for (const name of [command.command, ...(command.aliases ?? [])]) {
      const normalized = name.toLowerCase();
      if (reserved.has(normalized)) throw new Error(`Duplicate workspace command or alias: ${name}`);
      reserved.add(normalized);
    }
  }
  const actions = commands.filter((command) => command.uiAction).map(uiCommandAction);
  if (!actions.some((action) => action.id === "command.actions")) {
    actions.push({
      id: "command.actions", title: "All actions", description: "Search and run every workspace action.",
      group: "Workspace", command: "/actions", aliases: [], keywords: ["commands", "tools", "help"],
      scope: "global", target: { kind: "none" }, handler: { kind: "ui", action: "open_actions" },
      inputSchema: { type: "object", properties: {} }, surfaces: ["slash", "launcher", "button"],
      focus: "dialog", confirmation: "none",
    });
    reserved.add("/actions");
  }
  const toolNames = new Set(tools.map((tool) => tool.name));
  if (toolNames.size !== tools.length) throw new Error("Duplicate workspace tool name");
  for (const command of commands) {
    if (command.uiAction) continue;
    if (command.exposure === "composite" && !command.mcpTool) {
      actions.push(applicationCommandAction(command));
      continue;
    }
    if (!command.mcpTool || !toolNames.has(command.mcpTool.tool)) {
      throw new Error(`No registered handler for ${command.command}`);
    }
  }
  const coverage: WorkspaceActionCatalog["tools"] = [];
  for (const tool of tools) {
    groupForTool(tool.name);
    const workflow = workflowTools[tool.name];
    if (workflow) {
      coverage.push({ tool: tool.name, ...workflow, exposure: "workflow" });
      continue;
    }
    const linkedCommands = commands.filter((command) => command.mcpTool?.tool === tool.name);
    const action = toolAction(tool, linkedCommands[0], reserved);
    actions.push(action);
    for (const command of linkedCommands.slice(1)) {
      actions.push({ ...toolAction(tool, command, reserved), id: `command.${command.command.slice(1)}` });
    }
    coverage.push({ tool: tool.name, actionId: action.id, exposure: "action", reason: "Available in Actions with validated inputs." });
  }
  const actionIds = new Set(actions.map((action) => action.id));
  for (const action of actions) {
    for (const surface of action.surfaces) if (!surfaces.has(surface)) throw new Error(`No implemented surface ${surface} for ${action.id}`);
  }
  for (const entry of coverage) {
    if (!actionIds.has(entry.actionId)) throw new Error(`No visible owning action for ${entry.tool}: ${entry.actionId}`);
  }
  return { actions, tools: coverage };
}
