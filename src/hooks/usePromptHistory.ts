import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';
import type { PromptSurface } from '@/lib/prompt-surfaces';

export interface PromptHistoryEntry {
  id: number;
  surface: string;
  prompt: string;
  params: Record<string, unknown> | null;
  created_at: number;
}

export interface UsePromptHistoryResult {
  entries: string[];          // chronological (oldest → newest); navigation walks newest-first
  cursor: number;             // -1 = on draft; otherwise index into `entries`
  push: (prompt: string, params?: Record<string, unknown>) => void;
  navigateBack: (currentDraft: string) => string | null;
  navigateForward: () => string | null;
  reset: () => void;
}

export function usePromptHistory(
  callTool: UseMcpResult['callTool'] | undefined,
  surface: PromptSurface,
  bookId: string | undefined,
): UsePromptHistoryResult {
  const [entries, setEntries] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number>(-1);
  const entriesRef = useRef<string[]>([]);
  const cursorRef = useRef<number>(-1);
  const draftRef = useRef<string>('');
  const loadedKeyRef = useRef<string | null>(null);
  const callToolRef = useRef(callTool);
  const bookIdRef = useRef(bookId);

  useEffect(() => { callToolRef.current = callTool; });
  useEffect(() => { bookIdRef.current = bookId; });

  // Load persisted history when project or surface changes (or once callTool
  // becomes available). loadedKeyRef is only committed on success so a failed
  // load retries on the next effect run.
  useEffect(() => {
    if (!callTool || !bookId) return;
    const key = `${bookId}::${surface}`;
    if (key === loadedKeyRef.current) return;

    callTool('list_prompt_history', { book_id: bookId, surface, limit: 100 })
      .then((result) => {
        if (result.isError) return;
        const content = result.content as Array<{ type: string; text: string }>;
        const parsed = JSON.parse(content[0].text) as { entries: PromptHistoryEntry[] };
        // Server returns newest-first; reverse so navigateBack walks from end.
        const ordered = parsed.entries.map((e) => e.prompt).reverse();
        loadedKeyRef.current = key;
        entriesRef.current = ordered;
        cursorRef.current = -1;
        setEntries(ordered);
        setCursor(-1);
      })
      .catch(() => {});
  }, [callTool, bookId, surface]);

  const push = useCallback((prompt: string, params?: Record<string, unknown>) => {
    if (!prompt.trim()) return;
    const next = [...entriesRef.current, prompt];
    entriesRef.current = next;
    cursorRef.current = -1;
    setEntries(next);
    setCursor(-1);

    const slug = bookIdRef.current;
    const ct = callToolRef.current;
    if (slug && ct) {
      ct('record_prompt', {
        book_id: slug,
        surface,
        prompt,
        ...(params ? { params } : {}),
      }).catch(() => {});
    }
  }, [surface]);

  const navigateBack = useCallback((currentDraft: string): string | null => {
    const history = entriesRef.current;
    if (history.length === 0) return null;

    if (cursorRef.current === -1) {
      draftRef.current = currentDraft;
      cursorRef.current = history.length - 1;
      setCursor(cursorRef.current);
      return history[cursorRef.current];
    }

    if (cursorRef.current === 0) return null;

    cursorRef.current -= 1;
    setCursor(cursorRef.current);
    return history[cursorRef.current];
  }, []);

  const navigateForward = useCallback((): string | null => {
    if (cursorRef.current === -1) return null;
    const history = entriesRef.current;
    cursorRef.current += 1;
    if (cursorRef.current >= history.length) {
      cursorRef.current = -1;
      setCursor(-1);
      return draftRef.current;
    }
    setCursor(cursorRef.current);
    return history[cursorRef.current];
  }, []);

  const reset = useCallback(() => {
    cursorRef.current = -1;
    setCursor(-1);
  }, []);

  return { entries, cursor, push, navigateBack, navigateForward, reset };
}
