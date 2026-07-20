import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { ServerCommand, CommandArgValue, CommandToolArgs } from '@/lib/command-registry';
import { filterCommandsByMountKeys, normalizeApplySfxCommandArgs, normalizeKeywordCommandArgs, normalizeQrOutroCommandArgs, normalizeSyncAudioCommandArgs, normalizeTimewarpCommandArgs, parseCommandArgs, selectCommandForInput } from '@/lib/command-registry';
import { useMountKeys } from '@/contexts/MountKeyContext';
import type { UiActionMap } from '@/lib/ui-actions';
import { executeUiAction } from '@/lib/ui-actions';
import type { UseMcpResult } from 'use-mcp/react';

interface CommandRegistryContextValue {
  commands: ServerCommand[];
  allCommands: ServerCommand[];
  dispatch: (input: string) => Promise<boolean>;
  uiActions: UiActionMap;
}

const CommandRegistryContext = createContext<CommandRegistryContextValue | null>(null);

export function CommandRegistryProvider({
  callTool,
  state,
  projectSlug,
  uiActions,
  onAfterDispatch,
  children,
}: {
  callTool: UseMcpResult['callTool'];
  state: string;
  projectSlug: string | undefined;
  uiActions: UiActionMap;
  onAfterDispatch?: (toolName: string, toolArgs: CommandToolArgs) => void;
  children: React.ReactNode;
}) {
  const mountKeys = useMountKeys();
  const [allCommands, setAllCommands] = useState<ServerCommand[]>([]);

  useEffect(() => {
    if (state !== 'ready') return;
    let cancelled = false;
    (async () => {
      try {
        const result = await callTool('slash_commands', {});
        if (cancelled) return;
        const content = result.content as Array<{ type: string; text: string }>;
        const parsed: ServerCommand[] = JSON.parse(content[0].text);
        setAllCommands(parsed);
      } catch {
        // callTool may throw during connection transitions; safe to ignore
      }
    })();
    return () => { cancelled = true; };
  }, [callTool, state, projectSlug]);

  const commands = useMemo(
    () => filterCommandsByMountKeys(allCommands, mountKeys),
    [allCommands, mountKeys],
  );

  const dispatch = useCallback(async (input: string): Promise<boolean> => {
    const trimmed = input.trim();
    if (!trimmed) return false;

    const firstSpace = trimmed.indexOf(' ');
    const commandStr = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

    try {
      if (commandStr.startsWith('/')) {
        const cmd = selectCommandForInput(allCommands, commandStr, rest);
        if (cmd) {
          const args: Record<string, CommandArgValue> = parseCommandArgs(rest, cmd.params);
          const stringArgs: Record<string, string> = {};
          for (const [k, v] of Object.entries(args)) {
            if (Array.isArray(v)) stringArgs[k] = v.join(' ');
            else stringArgs[k] = String(v);
          }

          // uiAction dispatch
          if (cmd.uiAction) {
            // For switch_project, pass the slug from the command name
            if (cmd.uiAction === 'switch_project') {
              const slug = commandStr.slice(1); // remove leading /
              return executeUiAction(cmd.uiAction, uiActions, { raw: slug, args: stringArgs });
            }
            return executeUiAction(cmd.uiAction, uiActions, { raw: rest, args: stringArgs });
          }

          // mcpTool dispatch
          if (cmd.mcpTool) {
            const toolArgs: CommandToolArgs = { ...args };
            if (cmd.mcpTool.autoInject?.includes('project_slug') && projectSlug) {
              toolArgs.project_slug = projectSlug;
            }
            if (cmd.mcpTool.injectParams) {
              Object.assign(toolArgs, cmd.mcpTool.injectParams);
            }
            if (cmd.mcpTool.tool === 'create_qr_outro') {
              const inputs = toolArgs.inputs;
              if (!Array.isArray(inputs) || !inputs.every((input) => typeof input === 'string')) {
                throw new Error('/outroqr inputs are required');
              }
              delete toolArgs.inputs;
              Object.assign(toolArgs, normalizeQrOutroCommandArgs(inputs));
            }
            if (cmd.mcpTool.tool === 'animate_keywords') {
              const normalized = normalizeKeywordCommandArgs(toolArgs)
              delete toolArgs.inputs
              Object.assign(toolArgs, normalized)
            }
            if (cmd.mcpTool.tool === 'change_video_speed' && 'speed' in toolArgs) {
              const val = toolArgs.speed;
              delete toolArgs.speed;
              if (typeof val === 'string' && val.endsWith('s')) {
                toolArgs.target_duration_seconds = parseFloat(val);
              } else if (val !== undefined) {
                toolArgs.speed = parseFloat(String(val));
              }
            }
            if (cmd.mcpTool.tool === 'timewarp_video') {
              const normalized = normalizeTimewarpCommandArgs(toolArgs);
              delete toolArgs.range;
              delete toolArgs.factor;
              Object.assign(toolArgs, normalized);
            }
            if (cmd.mcpTool.tool === 'sync_video_to_audio') {
              const normalized = normalizeSyncAudioCommandArgs(toolArgs);
              delete toolArgs.mappings;
              Object.assign(toolArgs, normalized);
            }
            if (cmd.mcpTool.tool === 'apply_sfx') {
              const normalized = normalizeApplySfxCommandArgs(toolArgs);
              delete toolArgs.timestamp;
              delete toolArgs.type;
              delete toolArgs.description;
              Object.assign(toolArgs, normalized);
            }
            const result = await callTool(cmd.mcpTool.tool, toolArgs);
            if (!result.isError) onAfterDispatch?.(cmd.mcpTool.tool, toolArgs);
            return !result.isError;
          }

          // Chat fallback for commands with no mcpTool or uiAction
          if (projectSlug) {
            const result = await callTool('chat', { prompt: `${commandStr} ${rest}`.trim(), project_slug: projectSlug });
            return !result.isError;
          }
          return false;
        }
      }

      // General chat fallback — handles both natural language and bare commands
      // like "download URL". The chat router (GPT) parses intent reliably;
      // no need for a fragile positional-arg shortcut here.
      if (projectSlug) {
        const result = await callTool('chat', { prompt: trimmed, project_slug: projectSlug });
        return !result.isError;
      }
    } catch {
      // callTool may throw during MCP connection transitions; treat as failure
      return false;
    }
    return false;
  }, [allCommands, callTool, projectSlug, uiActions, onAfterDispatch]);

  const value = useMemo(
    () => ({ commands, allCommands, dispatch, uiActions }),
    [commands, allCommands, dispatch, uiActions],
  );

  return (
    <CommandRegistryContext.Provider value={value}>
      {children}
    </CommandRegistryContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalCommandRegistry(): CommandRegistryContextValue | null {
  return useContext(CommandRegistryContext);
}
