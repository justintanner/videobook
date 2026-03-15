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
  onMount?: string[];
}

export type CommandDescriptor = ServerCommand;

export function filterCommandsByMountKeys(
  commands: ServerCommand[],
  activeKeys: ReadonlySet<string>,
): ServerCommand[] {
  return commands.filter((cmd) => {
    if (!cmd.onMount || cmd.onMount.length === 0) return true;
    return cmd.onMount.every((key) => activeKeys.has(key));
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
