import { useCallback, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';

interface UseSetEnvSecretResult {
  setEnvSecret: (key: string, value: string) => Promise<boolean>;
  saving: string | null;
  error: string | null;
}

export function useSetEnvSecret(
  callTool: UseMcpResult['callTool'],
  state: UseMcpResult['state'],
): UseSetEnvSecretResult {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setEnvSecret = useCallback(
    async (key: string, value: string): Promise<boolean> => {
      if (state !== 'ready') {
        setError('MCP connection is not ready');
        return false;
      }
      setSaving(key);
      setError(null);
      try {
        const result = await callTool('set_env_secret', { key, value });
        if (result.isError) {
          const content = result.content as Array<{ type: string; text: string }> | undefined;
          setError(content?.[0]?.text ?? 'set_env_secret failed');
          return false;
        }
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setSaving(null);
      }
    },
    [callTool, state],
  );

  return { setEnvSecret, saving, error };
}
