import { useCallback, useRef, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';
import type { TimedCue, TranscriptState } from './types';

interface ToolTextResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

interface TimedResponse {
  kind: 'timed';
  language_code: string | null;
  text: string;
  words: Array<{ text: string; start: number; end: number; speaker_id?: string }>;
}

interface PlainResponse {
  kind: 'plain';
  text: string;
}

interface KindResponse {
  kind: 'silence' | 'missing';
}

type TranscriptResponse = TimedResponse | PlainResponse | KindResponse;

export function useTranscript() {
  const [state, setState] = useState<TranscriptState>({ status: 'loading' });
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchTranscript = useCallback(async (
    assetId: string,
    projectSlug: string,
    callTool: UseMcpResult['callTool'],
  ) => {
    const requestId = ++requestIdRef.current;
    setState({ status: 'loading' });
    setTranscribeError(null);

    try {
      const result = await callTool('read_transcript', {
        asset_id: assetId,
        project_slug: projectSlug,
      }) as ToolTextResult;

      if (requestIdRef.current !== requestId) return;

      if (result?.isError) {
        const msg = result.content?.[0]?.text ?? 'read_transcript failed';
        setState({ status: 'error', message: msg });
        return;
      }

      const raw = result.content?.[0]?.text;
      if (!raw) {
        setState({ status: 'error', message: 'Empty response from read_transcript' });
        return;
      }

      const parsed = JSON.parse(raw) as TranscriptResponse;

      if (requestIdRef.current !== requestId) return;

      switch (parsed.kind) {
        case 'timed': {
          const cues: TimedCue[] = parsed.words.map((w) => ({
            text: w.text,
            start: w.start,
            end: w.end,
            ...(w.speaker_id ? { speakerId: w.speaker_id } : {}),
          }));
          setState({
            status: 'timed',
            languageCode: parsed.language_code,
            cues,
            text: parsed.text,
          });
          break;
        }
        case 'plain':
          setState({ status: 'plain', text: parsed.text });
          break;
        case 'silence':
          setState({ status: 'silence' });
          break;
        case 'missing':
          setState({ status: 'missing' });
          break;
      }
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to load transcript',
      });
    }
  }, []);

  const requestTimedTranscript = useCallback(async (
    assetId: string,
    projectSlug: string,
    callTool: UseMcpResult['callTool'],
  ) => {
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const result = await callTool('transcribe', {
        asset_id: assetId,
        project_slug: projectSlug,
        wait: true,
      }) as ToolTextResult;

      if (result?.isError) {
        setTranscribeError(result.content?.[0]?.text ?? 'transcribe failed');
        return;
      }

      await fetchTranscript(assetId, projectSlug, callTool);
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : 'transcribe failed');
    } finally {
      setTranscribing(false);
    }
  }, [fetchTranscript]);

  return { state, fetchTranscript, transcribing, transcribeError, requestTimedTranscript };
}
