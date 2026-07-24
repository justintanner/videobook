import React, { useState, useEffect } from 'react';
import type { UseMcpResult } from 'use-mcp/react';

interface UseDefaultProjectResult {
  bookId: string | undefined;
  setProjectSlug: React.Dispatch<React.SetStateAction<string | undefined>>;
  loading: boolean;
  error: string | undefined;
}

interface DefaultProjectResolution {
  callTool: UseMcpResult['callTool'];
  readyEpoch: number;
  error?: string;
}

interface ConnectionEpoch {
  state: UseMcpResult['state'];
  readyEpoch: number;
}

export function useDefaultProject(
  callTool: UseMcpResult['callTool'],
  state: UseMcpResult['state'],
): UseDefaultProjectResult {
  const [bookId, setProjectSlug] = useState<string | undefined>();
  const [resolution, setResolution] = useState<DefaultProjectResolution>();
  const [connectionEpoch, setConnectionEpoch] = useState<ConnectionEpoch>({
    state,
    readyEpoch: state === 'ready' ? 1 : 0,
  });
  let readyEpoch = connectionEpoch.readyEpoch;

  if (connectionEpoch.state !== state) {
    readyEpoch = connectionEpoch.readyEpoch + (state === 'ready' ? 1 : 0);
    setConnectionEpoch({ state, readyEpoch });
  }

  useEffect(() => {
    if (state !== 'ready') return;
    let active = true;

    const resolve = async () => {
      try {
        const result = await callTool('ensure_default_project', {});
        if (!active) return;
        if (result.isError) {
          const content = result.content as Array<{ type: string; text: string }>;
          setResolution({ callTool, readyEpoch, error: content[0].text });
        } else {
          const content = result.content as Array<{ type: string; text: string }>;
          const parsed = JSON.parse(content[0].text) as { metadata: { slug: string } };
          setProjectSlug(parsed.metadata.slug);
          setResolution({ callTool, readyEpoch });
        }
      } catch (e: unknown) {
        if (!active) return;
        setResolution({ callTool, readyEpoch, error: e instanceof Error ? e.message : String(e) });
      }
    };

    void resolve();
    return () => {
      active = false;
    };
  }, [state, callTool, readyEpoch]);

  const currentResolution = state === 'ready'
    && resolution?.callTool === callTool
    && resolution.readyEpoch === readyEpoch
    ? resolution
    : undefined;
  const loading = state === 'ready' && currentResolution === undefined;
  const error = currentResolution?.error;

  return { bookId, setProjectSlug, loading, error };
}
