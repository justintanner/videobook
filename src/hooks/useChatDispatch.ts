import { useCallback, useEffect, useRef } from 'react';
import type { UseMcpResult } from 'use-mcp/react';
import type { Skill, SkillParam } from './useSkills';

interface ChatDispatchHandlers {
  onOpenInbox: () => void;
  onSwitchProject: (slug: string) => void;
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

interface UseChatDispatchResult {
  dispatch: (input: string) => Promise<void>;
}

export function parseSkillArgs(rest: string, params: SkillParam[]): Record<string, string> {
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

export function useChatDispatch(skills: Skill[], handlers: ChatDispatchHandlers): UseChatDispatchResult {
  const handlersRef = useRef(handlers);
  const skillsRef = useRef(skills);

  useEffect(() => { handlersRef.current = handlers; });
  useEffect(() => { skillsRef.current = skills; });

  const dispatch = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    const { onOpenInbox, onSwitchProject, callTool, projectSlug } = handlersRef.current;

    const firstSpace = trimmed.indexOf(' ');
    const command = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

    if (command.startsWith('/')) {
      const matchedSkill = skillsRef.current.find((s) => s.command === command);

      if (matchedSkill?.category === 'project') {
        onSwitchProject(command.slice(1));
        return;
      }

      if (matchedSkill?.uiAction) {
        const uiHandlers: Record<string, (r: string) => void> = {
          open_inbox: () => onOpenInbox(),
          copy_clipboard: (r: string) => { navigator.clipboard.writeText(r); },
        };
        uiHandlers[matchedSkill.uiAction]?.(rest);
        return;
      }

      if (matchedSkill?.mcpTool) {
        const args = parseSkillArgs(rest, matchedSkill.params);
        for (const key of matchedSkill.mcpTool.autoInject ?? []) {
          if (key === 'project_slug' && projectSlug) {
            args[key] = projectSlug;
          }
        }
        await callTool(matchedSkill.mcpTool.tool, args);
        return;
      }
    }

    // Default: forward to chat LLM
    if (projectSlug) {
      await callTool('chat', { prompt: trimmed, project_slug: projectSlug });
    }
  }, []);

  return { dispatch };
}
