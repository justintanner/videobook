import { useCallback, useEffect, useRef } from 'react';
import type { UseMcpResult } from 'use-mcp/react';
import type { Command, CommandParam } from './useCommands';

interface ChatDispatchHandlers {
  onOpenInbox: () => void;
  onUpload: () => void;
  onShowHistory: (assetId: string) => void;
  onOpenAsset: (assetId: string) => void;
  onSwitchProject: (slug: string) => void;
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

interface UseChatDispatchResult {
  dispatch: (input: string) => Promise<boolean>;
}

export function parseCommandArgs(rest: string, params: CommandParam[]): Record<string, string> {
  if (!rest || params.length === 0) return {};

  const tokens = rest.split(/\s+/);
  const args: Record<string, string> = {};

  for (let i = 0; i < params.length; i++) {
    if (i >= tokens.length) break;

    if (i === params.length - 1 && params[i].type === 'string') {
      // Last string param gets all remaining tokens joined
      const raw = tokens.slice(i).join(' ');
      args[params[i].name] = raw.startsWith('@') ? raw.slice(1) : raw;
    } else {
      const raw = tokens[i];
      args[params[i].name] = raw.startsWith('@') ? raw.slice(1) : raw;
    }
  }

  return args;
}

export function useChatDispatch(commands: Command[], handlers: ChatDispatchHandlers): UseChatDispatchResult {
  const handlersRef = useRef(handlers);
  const commandsRef = useRef(commands);

  useEffect(() => { handlersRef.current = handlers; });
  useEffect(() => { commandsRef.current = commands; });

  const dispatch = useCallback(async (input: string): Promise<boolean> => {
    const trimmed = input.trim();
    if (!trimmed) return false;

    const { onOpenInbox, onUpload, onShowHistory, onOpenAsset, onSwitchProject, callTool, projectSlug } = handlersRef.current;

    try {
      const firstSpace = trimmed.indexOf(' ');
      const command = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

      if (command.startsWith('/')) {
        const matchedCommand = commandsRef.current.find((s) => s.command === command);

        if (matchedCommand?.category === 'project') {
          onSwitchProject(command.slice(1));
          return true;
        }

        if (matchedCommand?.uiAction) {
          const uiHandlers: Record<string, (r: string) => void> = {
            open_inbox: () => onOpenInbox(),
            open_upload: () => onUpload(),
            show_history: (r: string) => { onShowHistory(r.startsWith('@') ? r.slice(1) : r); },
            open_asset: (r: string) => { onOpenAsset(r.startsWith('@') ? r.slice(1) : r); },
            copy_clipboard: (r: string) => { navigator.clipboard.writeText(r); },
          };
          uiHandlers[matchedCommand.uiAction]?.(rest);
          return true;
        }

        if (matchedCommand?.mcpTool) {
          const args = parseCommandArgs(rest, matchedCommand.params);
          for (const key of matchedCommand.mcpTool.autoInject ?? []) {
            if (key === 'project_slug' && projectSlug) {
              args[key] = projectSlug;
            }
          }
          const result = await callTool(matchedCommand.mcpTool.tool, args);
          return !result.isError;
        }
      }

      // Default: forward to chat LLM
      if (projectSlug) {
        const result = await callTool('chat', { prompt: trimmed, project_slug: projectSlug });
        return !result.isError;
      }

      return false;
    } catch {
      return false;
    }
  }, []);

  return { dispatch };
}
