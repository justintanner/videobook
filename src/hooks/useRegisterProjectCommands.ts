import { useEffect, useMemo } from 'react';
import type { UseMcpResult } from 'use-mcp/react';
import { useListProjects } from './useListProjects';
import { useRegisterCommands } from './useRegisterCommands';
import type { RegisteredCommand } from '@/lib/command-registry';

export function useRegisterProjectCommands(
  callTool: UseMcpResult['callTool'],
  state: string,
  onProjectChange: (slug: string) => void,
): void {
  const { projects, refresh } = useListProjects(callTool);

  useEffect(() => {
    if (state === 'ready') refresh();
  }, [state, refresh]);

  const cmds: RegisteredCommand[] = useMemo(() =>
    projects.map(p => ({
      command: `/${p.slug}`,
      description: `Switch to project ${p.slug}`,
      category: 'project' as const,
      icon: 'FolderOpen',
      size: 'default' as const,
      variant: 'default' as const,
      chevron: 'down' as const,
      params: [],
      handler: () => {
        onProjectChange(p.slug);
        return true;
      },
    })),
  [projects, onProjectChange]);

  useRegisterCommands(cmds);
}
