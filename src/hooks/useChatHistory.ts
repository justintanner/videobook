import { useRef, useCallback, useEffect } from 'react';
import type { UseMcpResult } from 'use-mcp/react';

export interface UseChatHistoryResult {
  push: (message: string) => void;
  navigateBack: (currentDraft: string) => string | null;
  navigateForward: () => string | null;
  reset: () => void;
}

export function useChatHistory(
  callTool: UseMcpResult['callTool'] | undefined,
  projectSlug: string | undefined,
): UseChatHistoryResult {
  const historyRef = useRef<string[]>([]);
  const cursorRef = useRef<number>(-1);
  const draftRef = useRef<string>('');
  const loadedSlugRef = useRef<string | null>(null);
  const callToolRef = useRef(callTool);
  const projectSlugRef = useRef(projectSlug);

  useEffect(() => { callToolRef.current = callTool; });
  useEffect(() => { projectSlugRef.current = projectSlug; });

  // Load persisted history when project changes
  useEffect(() => {
    const ct = callToolRef.current;
    if (!ct || !projectSlug || projectSlug === loadedSlugRef.current) return;
    loadedSlugRef.current = projectSlug;

    ct('list_chat_history', { project_slug: projectSlug, limit: 100 })
      .then((result) => {
        if (result.isError) return;
        const parsed = JSON.parse(result.content[0].text) as { messages: string[] };
        historyRef.current = parsed.messages;
        cursorRef.current = -1;
      })
      .catch(() => {});
  }, [projectSlug]);

  const push = useCallback((message: string) => {
    if (!message.trim()) return;
    historyRef.current.push(message);
    cursorRef.current = -1;

    const slug = projectSlugRef.current;
    const ct = callToolRef.current;
    if (slug && ct) {
      ct('push_chat_history', { message, project_slug: slug }).catch(() => {});
    }
  }, []);

  const navigateBack = useCallback((currentDraft: string): string | null => {
    const history = historyRef.current;
    if (history.length === 0) return null;

    // First navigation — save the current draft
    if (cursorRef.current === -1) {
      draftRef.current = currentDraft;
      cursorRef.current = history.length - 1;
      return history[cursorRef.current];
    }

    // Already at the oldest entry
    if (cursorRef.current === 0) return null;

    cursorRef.current -= 1;
    return history[cursorRef.current];
  }, []);

  const navigateForward = useCallback((): string | null => {
    if (cursorRef.current === -1) return null;

    const history = historyRef.current;

    // Move forward
    cursorRef.current += 1;

    // Past the newest entry — restore draft
    if (cursorRef.current >= history.length) {
      cursorRef.current = -1;
      return draftRef.current;
    }

    return history[cursorRef.current];
  }, []);

  const reset = useCallback(() => {
    cursorRef.current = -1;
  }, []);

  return { push, navigateBack, navigateForward, reset };
}
