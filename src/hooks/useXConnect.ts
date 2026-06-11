import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';

export interface XConnectStatus {
  connected: boolean;
  pending: boolean;
  has_credentials: boolean;
  error?: string;
  expires_at?: string;
}

interface ToolTextResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

interface UseXConnectCallbacks {
  onConnected?: () => void;
  onError?: (message: string) => void;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60_000;

function extractText(result: unknown): string | null {
  const r = result as ToolTextResult;
  if (!r || !Array.isArray(r.content) || r.content.length === 0) return null;
  const first = r.content[0];
  return typeof first.text === 'string' ? first.text : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function useXConnect(callTool: UseMcpResult['callTool'], callbacks?: UseXConnectCallbacks) {
  const [status, setStatus] = useState<XConnectStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // Bumping the epoch cancels any in-flight poll loop (on reset/reconnect/unmount).
  const pollEpochRef = useRef(0);
  const callbacksRef = useRef(callbacks);
  useEffect(() => { callbacksRef.current = callbacks; }, [callbacks]);

  const fetchStatus = useCallback(async (): Promise<XConnectStatus | null> => {
    try {
      const res = await callTool('x_connect_status', {});
      const r = res as ToolTextResult;
      if (r.isError) return null;
      const t = extractText(res);
      if (!t) return null;
      const parsed = JSON.parse(t) as XConnectStatus;
      setStatus(parsed);
      return parsed;
    } catch {
      return null;
    }
  }, [callTool]);

  const failConnect = useCallback((message: string) => {
    setConnecting(false);
    setConnectError(message);
    callbacksRef.current?.onError?.(message);
  }, []);

  const pollUntilSettled = useCallback(async (epoch: number, deadline: number) => {
    while (Date.now() <= deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (pollEpochRef.current !== epoch) return;
      const s = await fetchStatus();
      if (pollEpochRef.current !== epoch) return;
      if (s) {
        if (s.connected) {
          setConnecting(false);
          setConnectError(null);
          callbacksRef.current?.onConnected?.();
          return;
        }
        if (s.error && !s.pending) {
          failConnect(s.error);
          return;
        }
      }
    }
    failConnect('Timed out waiting for X authorization. Try again.');
  }, [fetchStatus, failConnect]);

  const connect = useCallback(async () => {
    if (connecting) return;
    setConnectError(null);
    setConnecting(true);
    try {
      const res = await callTool('x_connect_start', {});
      const r = res as ToolTextResult;
      if (r.isError) {
        failConnect(extractText(res) ?? 'Could not start X connect flow');
        return;
      }
      const t = extractText(res);
      if (!t) {
        failConnect('Empty response from x_connect_start');
        return;
      }
      const parsed = JSON.parse(t) as { authorize_url: string };
      window.open(parsed.authorize_url, '_blank', 'noopener,noreferrer');
      pollEpochRef.current += 1;
      void pollUntilSettled(pollEpochRef.current, Date.now() + POLL_TIMEOUT_MS);
    } catch (err) {
      failConnect(err instanceof Error ? err.message : String(err));
    }
  }, [callTool, connecting, pollUntilSettled, failConnect]);

  const reset = useCallback(() => {
    pollEpochRef.current += 1;
    setConnecting(false);
    setConnectError(null);
  }, []);

  useEffect(() => () => { pollEpochRef.current += 1; }, []);

  return { status, connecting, connectError, connect, fetchStatus, reset };
}
