import { useCallback, useRef } from 'react';
import type { UseMcpResult } from 'use-mcp/react';
import type { Skill } from './useSkills';

interface ChatDispatchHandlers {
  onOpenInbox: () => void;
  onSwitchProject: (slug: string) => void;
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

interface UseChatDispatchResult {
  dispatch: (input: string) => Promise<void>;
}

export function useChatDispatch(skills: Skill[], handlers: ChatDispatchHandlers): UseChatDispatchResult {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const skillsRef = useRef(skills);
  skillsRef.current = skills;

  const dispatch = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    const { onOpenInbox, onSwitchProject, callTool, projectSlug } = handlersRef.current;

    // Extract first token as potential command
    const firstSpace = trimmed.indexOf(' ');
    const command = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);

    if (command.startsWith('/')) {
      // Check for /inbox — pure UI command
      if (command === '/inbox') {
        onOpenInbox();
        return;
      }

      // Check for project-switch skill
      const matchedSkill = skillsRef.current.find((s) => s.command === command);
      if (matchedSkill?.category === 'project') {
        const slug = command.slice(1); // strip leading /
        onSwitchProject(slug);
        return;
      }

      // /copy-name @slug — clipboard copy
      if (command === '/copy-name') {
        const rest = trimmed.slice(firstSpace + 1).trim();
        if (rest) {
          await navigator.clipboard.writeText(rest);
        }
        return;
      }

      // /open-folder @slug — delegate to MCP
      if (command === '/open-folder') {
        const rest = trimmed.slice(firstSpace + 1).trim();
        const assetId = rest.startsWith('@') ? rest.slice(1) : rest;
        if (assetId && projectSlug) {
          await callTool('open_folder', { asset_id: assetId, project_slug: projectSlug });
        }
        return;
      }
    }

    // Default: forward everything to the chat MCP tool
    if (projectSlug) {
      await callTool('chat', { prompt: trimmed, project_slug: projectSlug });
    }
  }, []);

  return { dispatch };
}
