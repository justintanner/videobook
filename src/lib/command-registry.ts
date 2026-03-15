export interface CommandParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
}

export interface ServerCommand {
  command: string;
  description: string;
  example?: string;
  category: 'action' | 'project' | 'context_menu' | 'viewer';
  icon: string;
  size: 'sm' | 'default' | 'lg';
  variant: 'default' | 'violet';
  chevron: 'right' | 'down';
  params: CommandParam[];
  mcpTool?: { tool: string; autoInject?: string[] };
  uiAction?: string;
  visibleWhen?: { assetPrefix?: string[]; viewer?: boolean };
}

export type CommandDescriptor = ServerCommand;

export interface CommandScope {
  selectedAssetPrefix: string | null;
  viewerOpen: boolean;
}

export function filterCommandsByScope(commands: ServerCommand[], scope: CommandScope): ServerCommand[] {
  return commands.filter((cmd) => {
    if (!cmd.visibleWhen) return true;
    if (cmd.visibleWhen.viewer && !scope.viewerOpen) return false;
    if (cmd.visibleWhen.assetPrefix) {
      if (!scope.selectedAssetPrefix) return false;
      if (!cmd.visibleWhen.assetPrefix.includes(scope.selectedAssetPrefix)) return false;
    }
    return true;
  });
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
