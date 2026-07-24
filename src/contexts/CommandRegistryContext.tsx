import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { ServerCommand, CommandArgValue, CommandToolArgs } from '@/lib/command-registry';
import { adaptCommandArgs, filterCommandsByMountKeys, parseCommandArgs, selectCommandForInput } from '@/lib/command-registry';
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
  bookId,
  uiActions,
  onAfterDispatch,
  children,
}: {
  callTool: UseMcpResult['callTool'];
  state: string;
  bookId: string | undefined;
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
  }, [callTool, state, bookId]);

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
            let toolArgs: CommandToolArgs = { ...args };
            if (cmd.mcpTool.autoInject?.includes('book_id') && bookId) {
              toolArgs.book_id = bookId;
            }
            if (cmd.mcpTool.injectParams) {
              Object.assign(toolArgs, cmd.mcpTool.injectParams);
            }
            toolArgs = adaptCommandArgs(cmd.mcpTool.adapter, cmd.mcpTool.tool, toolArgs);
            const result = await callTool(cmd.mcpTool.tool, toolArgs);
            if (!result.isError) onAfterDispatch?.(cmd.mcpTool.tool, toolArgs);
            return !result.isError;
          }

          // Chat fallback for commands with no mcpTool or uiAction
          if (bookId) {
            const result = await callTool('chat', { prompt: `${commandStr} ${rest}`.trim(), book_id: bookId });
            return !result.isError;
          }
          return false;
        }
      }

      // General chat fallback — handles both natural language and bare commands
      // like "download URL". The chat router (GPT) parses intent reliably;
      // no need for a fragile positional-arg shortcut here.
      if (bookId) {
        const result = await callTool('chat', { prompt: trimmed, book_id: bookId });
        return !result.isError;
      }
    } catch {
      // callTool may throw during MCP connection transitions; treat as failure
      return false;
    }
    return false;
  }, [allCommands, callTool, bookId, uiActions, onAfterDispatch]);

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
