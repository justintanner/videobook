import { useState, useEffect, useCallback } from 'react';
import type { UseMcpResult } from 'use-mcp/react';

interface UseDefaultProjectResult {
  projectSlug: string | undefined;
  loading: boolean;
  error: string | undefined;
}

export function useDefaultProject(
  callTool: UseMcpResult['callTool'],
  state: UseMcpResult['state'],
): UseDefaultProjectResult {
  const [projectSlug, setProjectSlug] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const resolve = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await callTool('get_default_project', {});
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }>;
        setError(content[0].text);
      } else {
        const content = result.content as Array<{ type: string; text: string }>;
        const parsed = JSON.parse(content[0].text) as { metadata: { slug: string } };
        setProjectSlug(parsed.metadata.slug);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  useEffect(() => {
    if (state === 'ready') {
      resolve();
    }
  }, [state, resolve]);

  return { projectSlug, loading, error };
}
