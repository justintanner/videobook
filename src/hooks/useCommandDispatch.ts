import { useCallback } from 'react';
import { useOptionalCommandRegistry } from '@/contexts/CommandRegistryContext';
import type { RegisteredCommand } from '@/lib/command-registry';

interface UseCommandDispatchResult {
  dispatch: (input: string) => Promise<boolean>;
  commands: RegisteredCommand[];
}

export function useCommandDispatch(): UseCommandDispatchResult {
  const ctx = useOptionalCommandRegistry();
  const registry = ctx?.registry;

  const dispatch = useCallback(
    (input: string) => registry ? registry.dispatch(input) : Promise.resolve(false),
    [registry],
  );

  return { dispatch, commands: ctx?.commands ?? [] };
}
