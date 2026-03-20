import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { ServerCommand } from '@/lib/command-registry';
import { filterCommandsByMountKeys, parseCommandArgs } from '@/lib/command-registry';
import { useMountKeys } from '@/contexts/MountKeyContext';
import type { UiActionMap } from '@/lib/ui-actions';
import { executeUiAction } from '@/lib/ui-actions';
import type { UseMcpResult } from 'use-mcp/react';

interface CommandRegistryContextValue {
  commands: ServerCommand[];
  allCommands: ServerCommand[];
  dispatch: (input: string) => Promise<boolean>;
}

const CommandRegistryContext = createContext<CommandRegistryContextValue | null>(null);

export function CommandRegistryProvider({
  callTool,
  state,
  projectSlug,
  uiActions,
  children,
}: {
  callTool: UseMcpResult['callTool'];
  state: string;
  projectSlug: string | undefined;
  uiActions: UiActionMap;
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
        const cmd = allCommands.find((c) => c.command === commandStr);
        if (cmd) {
          const args = parseCommandArgs(rest, cmd.params);

          // uiAction dispatch
          if (cmd.uiAction) {
            // For switch_project, pass the slug from the command name
            if (cmd.uiAction === 'switch_project') {
              const slug = commandStr.slice(1); // remove leading /
              return executeUiAction(cmd.uiAction, uiActions, { raw: slug, args });
            }
            return executeUiAction(cmd.uiAction, uiActions, { raw: rest, args });
          }

          // mcpTool dispatch
          if (cmd.mcpTool) {
            const toolArgs: Record<string, string> = { ...args };
            if (cmd.mcpTool.autoInject?.includes('project_slug') && projectSlug) {
              toolArgs.project_slug = projectSlug;
            }
            const result = await callTool(cmd.mcpTool.tool, toolArgs);
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

      // Bare command match — dispatch "download URL" the same as "/download URL"
      const bareCmd = allCommands.find((c) => c.command === `/${commandStr}` && c.mcpTool);
      if (bareCmd) {
        const args = parseCommandArgs(rest, bareCmd.params);
        const toolArgs: Record<string, string> = { ...args };
        if (bareCmd.mcpTool!.autoInject?.includes('project_slug') && projectSlug) {
          toolArgs.project_slug = projectSlug;
        }
        const result = await callTool(bareCmd.mcpTool!.tool, toolArgs);
        return !result.isError;
      }

      // General chat fallback
      if (projectSlug) {
        const result = await callTool('chat', { prompt: trimmed, project_slug: projectSlug });
        return !result.isError;
      }
    } catch {
      // callTool may throw during MCP connection transitions; treat as failure
      return false;
    }
    return false;
  }, [allCommands, callTool, projectSlug, uiActions]);

  const value = useMemo(
    () => ({ commands, allCommands, dispatch }),
    [commands, allCommands, dispatch],
  );

  return (
    <CommandRegistryContext.Provider value={value}>
      {children}
    </CommandRegistryContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCommandRegistry(): CommandRegistryContextValue {
  const ctx = useContext(CommandRegistryContext);
  if (!ctx) throw new Error('useCommandRegistry must be used within CommandRegistryProvider');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalCommandRegistry(): CommandRegistryContextValue | null {
  return useContext(CommandRegistryContext);
}
