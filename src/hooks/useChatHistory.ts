import { useRef, useCallback } from 'react';

export interface UseChatHistoryResult {
  push: (message: string) => void;
  navigateBack: (currentDraft: string) => string | null;
  navigateForward: () => string | null;
  reset: () => void;
}

export function useChatHistory(): UseChatHistoryResult {
  const historyRef = useRef<string[]>([]);
  const cursorRef = useRef<number>(-1);
  const draftRef = useRef<string>('');

  const push = useCallback((message: string) => {
    if (message.trim()) {
      historyRef.current.push(message);
    }
    cursorRef.current = -1;
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
