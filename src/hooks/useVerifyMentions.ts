import { useCallback, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';

export interface MentionVerdict {
  handle: string;
  exists: boolean | null;
  display_name: string | null;
  summary: string | null;
}

interface VerifyMentionsState {
  status: 'idle' | 'checking' | 'done' | 'error';
  verdicts: MentionVerdict[];
  error: string | null;
}

interface ToolTextResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

const IDLE: VerifyMentionsState = { status: 'idle', verdicts: [], error: null };

export function useVerifyMentions(
  callTool: UseMcpResult['callTool'],
  bookId: string | undefined,
) {
  const [state, setState] = useState<VerifyMentionsState>(IDLE);

  const verify = useCallback(async (text: string) => {
    if (!bookId) return;
    setState({ status: 'checking', verdicts: [], error: null });
    try {
      const res = await callTool('verify_x_mentions', { text, book_id: bookId }) as ToolTextResult;
      const raw = Array.isArray(res.content) && res.content[0]?.text ? res.content[0].text : null;
      if (res.isError || !raw) {
        setState({ status: 'error', verdicts: [], error: raw ?? 'Mention verification failed' });
        return;
      }
      const parsed = JSON.parse(raw) as { mentions?: MentionVerdict[] };
      setState({ status: 'done', verdicts: parsed.mentions ?? [], error: null });
    } catch (err) {
      setState({ status: 'error', verdicts: [], error: err instanceof Error ? err.message : String(err) });
    }
  }, [callTool, bookId]);

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, verify, reset };
}
