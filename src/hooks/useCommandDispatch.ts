import { useCallback } from 'react';
import { useOptionalCommandRegistry } from '@/contexts/CommandRegistryContext';
import type { ServerCommand } from '@/lib/command-registry';

interface UseCommandDispatchResult {
  dispatch: (input: string) => Promise<boolean>;
  commands: ServerCommand[];
}

export function useCommandDispatch(): UseCommandDispatchResult {
  const ctx = useOptionalCommandRegistry();

  const dispatch = useCallback(
    (input: string) => ctx ? ctx.dispatch(input) : Promise.resolve(false),
    [ctx],
  );

  return { dispatch, commands: ctx?.commands ?? [] };
}
