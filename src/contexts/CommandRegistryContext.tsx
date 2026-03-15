import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { createCommandRegistry } from '@/lib/command-registry';
import type { CommandRegistry, RegisteredCommand } from '@/lib/command-registry';

interface CommandRegistryContextValue {
  registry: CommandRegistry;
  commands: RegisteredCommand[];
}

const CommandRegistryContext = createContext<CommandRegistryContextValue | null>(null);

export function CommandRegistryProvider({ chatFallback, children }: {
  chatFallback: (input: string) => Promise<boolean>;
  children: React.ReactNode;
}) {
  const [registry] = useState(() => createCommandRegistry(chatFallback));

  useEffect(() => {
    registry.setFallback(chatFallback);
  }, [registry, chatFallback]);

  const commands = useSyncExternalStore(
    registry.subscribe,
    registry.commands,
  );

  return (
    <CommandRegistryContext.Provider value={{ registry, commands }}>
      {children}
    </CommandRegistryContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCommandRegistry(): CommandRegistryContextValue {
  const ctx = useContext(CommandRegistryContext);
  if (!ctx) throw new Error('useCommandRegistry must be used within CommandRegistryProvider');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalCommandRegistry(): CommandRegistryContextValue | null {
  return useContext(CommandRegistryContext);
}
