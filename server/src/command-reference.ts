import type { GenerationActionSpec } from "./generation-registry.js";
import type { Command } from "./tools/video-editing-command-contract.js";
import type { ToolDef } from "./tools/tool-def.js";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeTable(value: string): string {
  return oneLine(value).replaceAll("|", "\\|");
}

export function renderCommandReference(
  tools: readonly ToolDef[],
  commands: readonly Command[],
  actions: readonly GenerationActionSpec[],
): string {
  const historicalNames = new Map(actions.map((action) => [action.canonical_name, action.legacy_names]));
  const toolLines = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const legacy = (historicalNames.get(tool.name) ?? []).filter((name) => name !== tool.name);
      const suffix = legacy.length > 0 ? ` (historical names, not exposed: ${legacy.map((name) => `\`${name}\``).join(", ")})` : "";
      return `- \`${tool.name}\`${suffix} — ${oneLine(tool.description)}`;
    });
  const commandLines = [...commands]
    .sort((a, b) => a.command.localeCompare(b.command))
    .map((command) => {
      const aliases = command.aliases ?? [];
      const aliasText = aliases.length > 0 ? ` (aliases: ${aliases.map((alias) => `\`${alias}\``).join(", ")})` : "";
      const target = command.mcpTool?.tool
        ? `; MCP: \`${command.mcpTool.tool}\``
        : command.uiAction
          ? `; UI: \`${command.uiAction}\``
          : "";
      return `- \`${command.command}\`${aliasText} — ${oneLine(command.description)}${target}`;
    });

  return `# Command Reference

Every current MCP endpoint and canonical slash command is listed once. Historical MCP names are lookup-only compatibility keys and are not registered endpoints; slash aliases remain accepted but are hidden from command catalogs.

## MCP endpoints (${tools.length})

${toolLines.join("\n")}

## Slash commands (${commands.length} static commands)

${commandLines.join("\n")}
- \`/<project-name>\` — Switch to that project; generated dynamically for each project whose name does not conflict with a command or alias.
`;
}

export function renderGenerationNamingManifest(actions: readonly GenerationActionSpec[]): string {
  const providerActions = actions.filter((action) => action.provider !== "workflow").length;
  const rows = actions.map((action) => (
    `| \`${escapeTable(action.canonical_name)}\` | ${action.provider} | \`${escapeTable(action.apicity_identifier)}\` | ${action.media_type} | ${action.operation} | ${action.picker_visibility} | ${action.legacy_names.map((name) => `\`${escapeTable(name)}\``).join(", ")} |`
  ));

  return `# Generation Naming Manifest

This is the authoritative registry-derived list of canonical generation and workflow action names. Historical names resolve persisted data to canonical names but are not exposed as MCP endpoints.

## Summary

- Total actions: ${actions.length}
- Provider actions: ${providerActions}
- Workflow and support actions: ${actions.length - providerActions}

## Naming grammar

Provider-backed actions use \`<verb>_<provider>_<model>_<operation>\`. Workflow actions use concise intent-based names.

| Canonical action | Provider | Apicity or internal identifier | Media | Operation | Picker visibility | Historical names (not exposed) |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}
