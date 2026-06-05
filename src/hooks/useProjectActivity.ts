import { useState, useCallback, useRef } from "react";
import type { UseMcpResult } from "use-mcp/react";

export interface ActionLogEntry {
  hash: string;
  action: string;
  title?: string;
  category?: 'generate' | 'render' | 'upload' | 'transcribe' | 'trim' | 'edit' | 'create' | 'delete' | 'fail' | 'rewind' | 'other';
  source?: 'action' | 'snapshot';
  payload?: string | Record<string, unknown>;
  date: string;
  rewindable?: boolean;
  assetId?: string;
}

interface UseProjectActivityResult {
  entries: ActionLogEntry[];
  loading: boolean;
  fetch: (projectSlug: string) => Promise<void>;
}

export function useProjectActivity(callTool: UseMcpResult["callTool"]): UseProjectActivityResult {
  const [entries, setEntries] = useState<ActionLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;

  const fetch = useCallback(async (projectSlug: string) => {
    setLoading(true);
    try {
      const result = await callToolRef.current("project_activity", { project_slug: projectSlug, limit: 50 });
      if (!result.isError) {
        const content = result.content as Array<{ type: string; text: string }>;
        setEntries(JSON.parse(content[0].text) as ActionLogEntry[]);
      }
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, []);

  return { entries, loading, fetch };
}
