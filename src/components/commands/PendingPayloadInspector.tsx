import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { UseMcpResult } from 'use-mcp/react';
import { useGenerationPayload, type GenerationPayloadResponse } from '@/hooks/useGenerationPayload';

interface PendingPayloadInspectorProps {
  projectSlug: string;
  assetId: string;
  slug: string;
  taskType: string;
  callTool: UseMcpResult['callTool'];
}

type MediaRef = { url: string; kind: 'image' | 'video' | 'audio'; role: string };

const MEDIA_FIELDS: ReadonlyArray<string> = [
  'reference_image_urls', 'reference_video_urls', 'reference_audio_urls',
  'first_frame_url', 'last_frame_url', 'first_clip_url', 'driving_audio_url',
  'image_urls', 'image_url', 'video_url',
  'reference_image', 'reference_video', 'reference_voice', 'first_frame',
  'input_urls', 'image_input',
];

function classifyUrl(url: string): 'image' | 'video' | 'audio' {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'].includes(ext)) return 'audio';
  return 'image';
}

function walkForUrls(value: unknown, role: string, out: MediaRef[]): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      out.push({ url: value, kind: classifyUrl(value), role });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkForUrls(item, role, out);
    return;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === 'string') {
      walkForUrls(obj.url, role, out);
      return;
    }
  }
}

function extractMediaUrls(payload: unknown): MediaRef[] {
  if (!payload || typeof payload !== 'object') return [];
  const out: MediaRef[] = [];
  const root = payload as Record<string, unknown>;
  const input = (root.input && typeof root.input === 'object') ? root.input as Record<string, unknown> : root;
  for (const key of MEDIA_FIELDS) {
    if (key in input) walkForUrls(input[key], key, out);
  }
  // Dedupe by url while preserving order
  const seen = new Set<string>();
  return out.filter((m) => {
    if (seen.has(m.url)) return false;
    seen.add(m.url);
    return true;
  });
}

export function PendingPayloadInspector({
  projectSlug,
  assetId,
  slug,
  taskType,
  callTool,
}: PendingPayloadInspectorProps) {
  const { fetchPayload } = useGenerationPayload(callTool);
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; data: GenerationPayloadResponse }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchPayload(projectSlug, assetId).then((r) => {
      if (cancelled) return;
      if (r.ok) setState({ kind: 'ready', data: r.data });
      else setState({ kind: 'error', message: r.error });
    });
    return () => { cancelled = true; };
  }, [fetchPayload, projectSlug, assetId]);

  return (
    <div className="w-[500px] max-h-[70vh] overflow-y-auto rounded-lg border border-cyan-500/40 bg-zinc-950/95 p-3 font-mono text-[11px] text-zinc-200 shadow-2xl backdrop-blur-sm">
      <div className="flex items-baseline justify-between gap-2 border-b border-cyan-500/20 pb-2 mb-2">
        <span className="text-cyan-400 truncate font-bold tracking-wide">{slug}</span>
        <span className="text-[9px] text-zinc-500 tracking-wider shrink-0">{taskType || 'unknown'}</span>
      </div>

      {state.kind === 'loading' && (
        <div className="text-zinc-500 italic">Loading payload...</div>
      )}

      {state.kind === 'error' && (
        <div className="flex items-start gap-2 rounded border border-red-900/40 bg-red-950/20 p-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
          <span className="text-red-200/90">Failed to load payload: {state.message}</span>
        </div>
      )}

      {state.kind === 'ready' && <ReadyContent data={state.data} />}
    </div>
  );
}

function ReadyContent({ data }: { data: GenerationPayloadResponse }) {
  const media = extractMediaUrls(data.payload);
  const hasPayload = data.payload != null;
  const hasError = data.error != null;

  return (
    <div className="flex flex-col gap-2">
      {hasError && (
        <div className="flex items-start gap-2 rounded border border-red-900/40 bg-red-950/20 p-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[9px] uppercase tracking-wider text-red-400/70">Error</div>
            <p className="text-red-200/90 whitespace-pre-wrap break-words leading-snug">
              {data.error!.message}
            </p>
            {data.error!.failCode && (
              <div className="text-[9px] text-red-400/60 mt-1">code: {data.error!.failCode}</div>
            )}
          </div>
        </div>
      )}

      {!hasPayload && (
        <div className="rounded border border-zinc-800 bg-zinc-900/50 p-2 text-zinc-500 italic">
          Payload not built — task failed before request construction.
        </div>
      )}

      {media.length > 0 && (
        <div>
          <div className="text-[9px] uppercase tracking-wider text-cyan-500/70 mb-1">Reference media</div>
          <div className="flex flex-wrap gap-1.5">
            {media.map((m) => (
              <MediaThumb key={m.url} media={m} />
            ))}
          </div>
        </div>
      )}

      {hasPayload && (
        <div>
          <div className="text-[9px] uppercase tracking-wider text-cyan-500/70 mb-1">Payload</div>
          <pre className="rounded border border-zinc-800 bg-black/60 p-2 overflow-x-auto text-[10px] leading-snug text-zinc-300 whitespace-pre">
            {JSON.stringify(data.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function MediaThumb({ media }: { media: MediaRef }) {
  if (media.kind === 'video') {
    return (
      <div className="relative w-20 h-20 rounded border border-zinc-800 overflow-hidden bg-black" title={`${media.role}: ${media.url}`}>
        <video
          src={media.url}
          className="w-full h-full object-cover"
          muted
          playsInline
          preload="metadata"
        />
        <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-[8px] text-cyan-400 px-1 truncate">
          VIDEO
        </span>
      </div>
    );
  }
  if (media.kind === 'audio') {
    return (
      <div className="w-20 h-20 rounded border border-zinc-800 bg-black flex flex-col items-center justify-center p-1" title={`${media.role}: ${media.url}`}>
        <span className="text-[8px] text-cyan-400 mb-1">AUDIO</span>
        <audio src={media.url} controls className="w-full h-6" />
      </div>
    );
  }
  return (
    <img
      src={media.url}
      alt={media.role}
      title={`${media.role}: ${media.url}`}
      className="w-20 h-20 rounded border border-zinc-800 object-cover bg-black"
    />
  );
}
