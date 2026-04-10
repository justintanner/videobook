import { useEffect, useState } from 'react';
import { ChevronRight, ChevronLeft, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getCardOrientation,
  getCardWidthClass,
  getRatioLabel,
  getRatioBadgeClasses,
  getTaskInfo,
  getCurrentPhase,
  isFailedPending,
} from './inbox-utils';
import type { MediaItem } from '@/components/sidebar/types';

interface InboxPendingCardProps {
  video: MediaItem;
}

const CYAN_RGB = '6, 182, 212';

export function InboxPendingCard({ video }: InboxPendingCardProps) {
  if (isFailedPending(video)) return <FailedCard video={video} />;
  return <ActiveCard video={video} />;
}

function ActiveCard({ video }: { video: MediaItem }) {
  const orientation = getCardOrientation(video.width, video.height);
  const widthClass = getCardWidthClass(orientation);
  const taskInfo = getTaskInfo(video.pendingTaskType);
  const phase = getCurrentPhase(video);
  const layerColor = (alpha: number) => `rgba(${CYAN_RGB}, ${alpha})`;

  return (
    <div
      className={cn(
        widthClass,
        'h-[260px] rounded-lg overflow-hidden relative shrink-0 border border-cyan-500/40 bg-black',
      )}
      style={{ ['--gen-color' as string]: CYAN_RGB }}
    >
      {/* Layer 1: CRT scanlines */}
      <div
        className="absolute inset-0 pointer-events-none opacity-40"
        style={{
          background: `repeating-linear-gradient(0deg, transparent, transparent 2px, ${layerColor(0.05)} 2px, ${layerColor(0.05)} 4px)`,
        }}
      />

      {/* Layer 2: 8x8 pixel grid */}
      <div
        className="absolute inset-0 pointer-events-none opacity-15"
        style={{
          backgroundImage: `linear-gradient(${layerColor(0.2)} 1px, transparent 1px), linear-gradient(90deg, ${layerColor(0.2)} 1px, transparent 1px)`,
          backgroundSize: '8px 8px',
        }}
      />

      {/* Layer 3: Diagonal particle streams */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {[0, 1, 2, 3].map((stream) => (
          <div key={stream} className="absolute inset-0">
            {[0, 1, 2, 3, 4, 5].map((dot) => (
              <div
                key={dot}
                className="absolute w-1 h-1 rounded-full"
                style={{
                  left: `${18 + stream * 20}%`,
                  bottom: `${dot * 15}%`,
                  backgroundColor: layerColor(0.6),
                  boxShadow: `0 0 4px ${layerColor(0.4)}`,
                  animation: `generating-particle-rise ${2.5 + stream * 0.4}s linear infinite`,
                  animationDelay: `${stream * 0.3 + dot * 0.35}s`,
                }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Layer 4: HUD corner brackets */}
      <div className="absolute top-1.5 left-1.5 w-2.5 h-2.5 border-l-2 border-t-2" style={{ borderColor: layerColor(0.7) }} />
      <div className="absolute top-1.5 right-1.5 w-2.5 h-2.5 border-r-2 border-t-2" style={{ borderColor: layerColor(0.7) }} />
      <div className="absolute bottom-1.5 left-1.5 w-2.5 h-2.5 border-l-2 border-b-2" style={{ borderColor: layerColor(0.7) }} />
      <div className="absolute bottom-1.5 right-1.5 w-2.5 h-2.5 border-r-2 border-b-2" style={{ borderColor: layerColor(0.7) }} />

      {/* Content */}
      <div className="relative z-10 h-full flex flex-col p-3 gap-2">
        <div className="flex items-center justify-center gap-1 overflow-hidden">
          <ChevronRight className="w-2.5 h-2.5 flex-shrink-0" style={{ color: layerColor(0.5) }} />
          <span
            className="truncate text-[11px] font-mono font-bold tracking-wide"
            style={{ color: layerColor(1), textShadow: `0 0 8px ${layerColor(0.8)}` }}
          >
            {video.slug}
          </span>
          <ChevronLeft className="w-2.5 h-2.5 flex-shrink-0" style={{ color: layerColor(0.5) }} />
        </div>

        <div className="flex flex-col items-center gap-0.5">
          <div
            className="px-2 py-1 text-[10px] font-mono font-bold tracking-[0.2em] border animate-[generating-model-pulse_2s_ease-in-out_infinite]"
            style={{
              color: layerColor(1),
              borderColor: layerColor(0.6),
              backgroundColor: layerColor(0.15),
              boxShadow: `0 0 8px ${layerColor(0.6)}`,
              textShadow: `0 0 8px ${layerColor(0.9)}`,
            }}
          >
            GENERATING
          </div>
          <ElapsedTimer startedAt={video.createdAt} />
        </div>

        <div className="flex flex-col gap-0.5 px-1 text-[10px] font-mono">
          <DetailRow label="MODEL"    value={taskInfo.model}    color={CYAN_RGB} />
          <DetailRow label="PROVIDER" value={taskInfo.provider} color={CYAN_RGB} />
          <DetailRow label="PHASE"    value={phase}             color={CYAN_RGB} />
        </div>

        <div className="mt-auto flex items-end gap-2 pt-1.5 border-t" style={{ borderColor: layerColor(0.2) }}>
          <span
            className="flex-1 text-[10px] font-mono italic line-clamp-2 leading-tight"
            style={{ color: layerColor(0.6) }}
          >
            {video.prompt?.trim() ? `"${video.prompt}"` : '— no prompt —'}
          </span>
          <span className={cn('shrink-0 text-[10px] font-mono px-1 rounded', getRatioBadgeClasses(orientation))}>
            {getRatioLabel(orientation)}
          </span>
        </div>
      </div>

      {/* Layer 5: Scanline sweep */}
      <div
        className="absolute inset-0 pointer-events-none h-8"
        style={{
          background: `linear-gradient(to bottom, transparent, ${layerColor(0.12)}, transparent)`,
          animation: 'overlay-scanline-sweep 3s linear infinite',
        }}
      />
    </div>
  );
}

function FailedCard({ video }: { video: MediaItem }) {
  const orientation = getCardOrientation(video.width, video.height);
  const widthClass = getCardWidthClass(orientation);
  const taskInfo = getTaskInfo(video.failedTaskType || video.pendingTaskType);
  const hasModel = taskInfo.model !== '—';
  const errorText = video.failedMessage?.trim() || 'Generation failed without an error message.';
  const whenText = formatRelativeAgo(video.failedAt);

  return (
    <div
      className={cn(
        widthClass,
        'h-[260px] rounded-lg overflow-hidden relative shrink-0',
        'border border-red-900/60 bg-zinc-950',
      )}
    >
      {/* Subtle red wash, no motion */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at top, rgba(127, 29, 29, 0.25) 0%, transparent 70%)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 h-full flex flex-col p-3 gap-2">
        {/* Slug header */}
        <div className="flex items-center gap-1 overflow-hidden">
          <span className="truncate text-[11px] font-mono text-zinc-500">{video.slug}</span>
          <span className="ml-auto shrink-0 text-[9px] font-mono text-zinc-600">{whenText}</span>
        </div>

        {/* Failed badge */}
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          <span className="text-xs font-mono font-bold tracking-[0.15em] text-red-400">
            FAILED
          </span>
          {hasModel && (
            <span className="ml-auto text-[10px] font-mono text-zinc-500 truncate">
              {taskInfo.model}
            </span>
          )}
        </div>

        {/* Error message — main content */}
        <div className="flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto rounded border border-red-900/40 bg-red-950/20 p-2">
            <p className="text-[10px] font-mono text-red-200/85 leading-snug whitespace-pre-wrap break-words">
              {errorText}
            </p>
          </div>
        </div>

        {/* Footer: prompt + ratio */}
        <div className="flex items-end gap-2 pt-1.5 border-t border-zinc-800">
          <span className="flex-1 text-[10px] font-mono italic text-zinc-600 truncate leading-tight">
            {video.prompt?.trim() ? `"${video.prompt}"` : '— no prompt —'}
          </span>
          <span className={cn('shrink-0 text-[10px] font-mono px-1 rounded', getRatioBadgeClasses(orientation))}>
            {getRatioLabel(orientation)}
          </span>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-14 shrink-0 tracking-wider" style={{ color: `rgba(${color}, 0.45)` }}>
        {label}
      </span>
      <span className="truncate font-bold" style={{ color: `rgba(${color}, 0.95)` }}>
        {value}
      </span>
    </div>
  );
}

function ElapsedTimer({ startedAt }: { startedAt: string | undefined }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const text = formatElapsed(startedAt, now);

  return (
    <span
      className="text-2xl font-mono font-bold tabular-nums tracking-tight leading-none"
      style={{
        color: `rgba(${CYAN_RGB}, 1)`,
        textShadow: `0 0 12px rgba(${CYAN_RGB}, 0.9)`,
      }}
    >
      {text}
    </span>
  );
}

function formatElapsed(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '--:--';
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return '--:--';
  const elapsed = Math.max(0, Math.floor((now - startMs) / 1000));
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatRelativeAgo(iso: string | undefined): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
