export interface CommandParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
}

export interface CommandDescriptor {
  command: string;
  description: string;
  example?: string;
  category: 'action' | 'project' | 'context_menu';
  icon: string;
  size: 'sm' | 'default' | 'lg';
  variant: 'default' | 'violet';
  chevron: 'right' | 'down';
  params: CommandParam[];
}

export interface RegisteredCommand extends CommandDescriptor {
  handler: (ctx: { raw: string; args: Record<string, string> }) => Promise<boolean> | boolean;
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

export interface CommandRegistry {
  commands: () => RegisteredCommand[];
  register: (cmd: RegisteredCommand) => void;
  unregister: (command: string) => void;
  subscribe: (listener: () => void) => () => void;
  dispatch: (input: string) => Promise<boolean>;
  setFallback: (fn: (input: string) => Promise<boolean>) => void;
}

export function createCommandRegistry(initialFallback: (input: string) => Promise<boolean>): CommandRegistry {
  const map = new Map<string, RegisteredCommand>();
  const listeners = new Set<() => void>();
  let chatFallback = initialFallback;
  let cachedCommands: RegisteredCommand[] = [];

  function notify(): void {
    cachedCommands = Array.from(map.values());
    for (const listener of listeners) listener();
  }

  return {
    commands: () => cachedCommands,

    register(cmd: RegisteredCommand) {
      map.set(cmd.command, cmd);
      notify();
    },

    unregister(command: string) {
      if (map.delete(command)) notify();
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    setFallback(fn: (input: string) => Promise<boolean>) {
      chatFallback = fn;
    },

    async dispatch(input: string): Promise<boolean> {
      const trimmed = input.trim();
      if (!trimmed) return false;

      const firstSpace = trimmed.indexOf(' ');
      const command = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

      if (command.startsWith('/')) {
        const registered = map.get(command);
        if (registered) {
          const args = parseCommandArgs(rest, registered.params);
          try {
            return await registered.handler({ raw: rest, args });
          } catch {
            return false;
          }
        }
      }

      return chatFallback(trimmed);
    },
  };
}
