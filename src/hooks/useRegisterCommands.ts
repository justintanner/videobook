import { useEffect, useRef } from 'react';
import { useOptionalCommandRegistry } from '@/contexts/CommandRegistryContext';
import type { RegisteredCommand } from '@/lib/command-registry';

export function useRegisterCommands(cmds: RegisteredCommand[]): void {
  const ctx = useOptionalCommandRegistry();
  const registry = ctx?.registry;
  const handlersRef = useRef(cmds.map(c => c.handler));

  useEffect(() => {
    handlersRef.current = cmds.map(c => c.handler);
  });

  const commandNames = cmds.map(c => c.command).join(',');

  useEffect(() => {
    if (!registry) return;

    const registered = cmds.map((cmd, i) => ({
      ...cmd,
      handler: (ctx: { raw: string; args: Record<string, string> }) => handlersRef.current[i](ctx),
    }));

    for (const cmd of registered) {
      registry.register(cmd);
    }

    return () => {
      for (const cmd of registered) {
        registry.unregister(cmd.command);
      }
    };
  }, [registry, commandNames]); // eslint-disable-line react-hooks/exhaustive-deps
}
