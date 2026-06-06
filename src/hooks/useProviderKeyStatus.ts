import { useCallback, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';

export type ProviderKeyStatus = 'configured' | 'missing' | 'placeholder';
export type ProviderCreditsStatus = 'ok' | 'missing_key' | 'placeholder_key' | 'error';

export interface ProviderCreditsInfo {
  status: ProviderCreditsStatus;
  value: number | null;
  unit: 'credits';
  fetchedAt: string | null;
  message: string | null;
}

export interface ProviderKeyInfo {
  provider: 'kie';
  label: 'Kie';
  envKey: 'KIE_API_KEY';
  keyStatus: ProviderKeyStatus;
  maskedKey: string | null;
  credits: ProviderCreditsInfo;
}

export interface ProviderKeyStatusResponse {
  providers: ProviderKeyInfo[];
}

interface UseProviderKeyStatusResult {
  data: ProviderKeyStatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useProviderKeyStatus(
  callTool: UseMcpResult['callTool'],
  state: UseMcpResult['state'],
): UseProviderKeyStatusResult {
  const [data, setData] = useState<ProviderKeyStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (state !== 'ready') {
      setError('MCP connection is not ready');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await callTool('provider_key_status', {});
      const content = result.content as Array<{ type: string; text: string }> | undefined;
      const text = content?.[0]?.text;
      if (result.isError) {
        setError(text ?? 'provider_key_status failed');
        return;
      }
      if (!text) {
        setError('provider_key_status returned no data');
        return;
      }
      setData(JSON.parse(text) as ProviderKeyStatusResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [callTool, state]);

  return { data, loading, error, refresh };
}
