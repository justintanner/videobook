export interface CommandParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required: boolean;
  description: string;
}

export type CommandArgValue = string | string[];

export interface ServerCommand {
  command: string;
  description: string;
  example?: string;
  category: 'action' | 'project' | 'context_menu' | 'viewer';
  icon: string;
  size: 'sm' | 'default' | 'lg';
  variant: 'default' | 'violet' | 'fuchsia' | 'blue' | 'zinc' | 'amber' | 'emerald' | 'pink';
  chevron: 'right' | 'down';
  params: CommandParam[];
  mcpTool?: { tool: string; autoInject?: string[]; injectParams?: Record<string, string | number | boolean> };
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

const stripAt = (token: string): string => (token.startsWith('@') ? token.slice(1) : token);

export function parseCommandArgs(rest: string, params: CommandParam[]): Record<string, CommandArgValue> {
  if (!rest || params.length === 0) return {};

  const tokens = rest.split(/\s+/);
  const args: Record<string, CommandArgValue> = {};

  for (let i = 0; i < params.length; i++) {
    if (i >= tokens.length) break;
    const param = params[i];
    const isLast = i === params.length - 1;

    if (isLast && param.type === 'string[]') {
      args[param.name] = tokens.slice(i).map(stripAt);
    } else if (isLast && param.type === 'string') {
      // Last string param gets all remaining tokens joined.
      // Strip leading "to" connector (e.g. "/rename @slug to new-name")
      let remaining = tokens.slice(i);
      if (remaining.length > 1 && remaining[0].toLowerCase() === 'to') {
        remaining = remaining.slice(1);
      }
      const raw = remaining.join(' ');
      args[param.name] = stripAt(raw);
    } else {
      args[param.name] = stripAt(tokens[i]);
    }
  }

  return args;
}
