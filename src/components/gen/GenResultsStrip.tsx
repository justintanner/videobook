import { useState } from 'react';
import { Loader2, Play, X, CornerDownRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GenSection } from '@/components/gen/ui/GenSection';
import type { MediaItem } from '@/components/sidebar/types';
import { buildResultTiles, type ResultGhost, type ResultTile } from '@/components/gen/resultTiles';

interface GenResultsStripProps {
  clips: MediaItem[];
  ghosts: ResultGhost[];
  /** Feed a finished clip into the active model's video-edit input. */
  onExtend?: (tile: ResultTile) => void;
  /** Whether the active model can take a video (has a video_slug). */
  extendEnabled: boolean;
  /** Tooltip shown on the extend affordance when disabled. */
  extendHint?: string;
  disabled?: boolean;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  return `${seconds.toFixed(1)}s`;
}

export function GenResultsStrip({
  clips,
  ghosts,
  onExtend,
  extendEnabled,
  extendHint,
  disabled,
}: GenResultsStripProps) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [erroredThumbs, setErroredThumbs] = useState<Set<string>>(new Set());
  const tiles = buildResultTiles(clips, ghosts);

  if (tiles.length === 0) return null;

  return (
    <GenSection label="results" color="video" bodyClassName="px-2 py-2">
      <div className="flex gap-2 overflow-x-auto [scrollbar-width:thin] pb-1">
        {tiles.map((tile) => {
          const playing = playingId === tile.id && !!tile.videoSrc;
          const durLabel = formatDuration(tile.duration);
          const thumbOk = tile.thumbSrc != null && !erroredThumbs.has(tile.thumbSrc);
          const canExtend = !!onExtend && !tile.pending && !tile.failed;

          return (
            <div
              key={tile.id}
              className={cn(
                'group relative shrink-0 w-36 h-20 rounded overflow-hidden border border-violet-500/20 bg-black/50',
                disabled && 'opacity-50 pointer-events-none',
              )}
              title={tile.prompt ?? tile.title}
            >
              {playing ? (
                <>
                  <video
                    src={tile.videoSrc}
                    controls
                    autoPlay
                    className="w-full h-full object-cover bg-black"
                  />
                  <button
                    type="button"
                    onClick={() => setPlayingId(null)}
                    className="absolute top-1 right-1 z-10 w-5 h-5 flex items-center justify-center rounded bg-black/70 text-violet-200 hover:text-white"
                    title="Close"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              ) : (
                <>
                  {tile.pending ? (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-violet-500/[0.06] animate-pulse">
                      <Loader2 className="w-4 h-4 animate-spin text-violet-300/70" />
                      <span className="px-1 text-[9px] font-mono text-violet-300/60 truncate max-w-full">
                        {tile.failed ? 'failed' : 'generating'}
                      </span>
                    </div>
                  ) : thumbOk ? (
                    <img
                      src={tile.thumbSrc as string}
                      alt={tile.title}
                      loading="lazy"
                      draggable={false}
                      className="w-full h-full object-cover"
                      onError={() =>
                        setErroredThumbs((prev) => new Set(prev).add(tile.thumbSrc as string))
                      }
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-violet-500/[0.04]">
                      <Play className="w-4 h-4 text-violet-300/40" />
                    </div>
                  )}

                  {tile.failed && (
                    <div className="absolute inset-0 flex items-center justify-center bg-red-500/10">
                      <span className="text-[9px] font-mono text-red-300/80 tracking-wider">FAILED</span>
                    </div>
                  )}

                  {/* Play affordance on hover for ready clips */}
                  {!tile.pending && !tile.failed && tile.videoSrc && (
                    <button
                      type="button"
                      onClick={() => setPlayingId(tile.id)}
                      className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Play"
                    >
                      <Play className="w-6 h-6 text-white drop-shadow" fill="currentColor" />
                    </button>
                  )}

                  {durLabel && (
                    <span className="absolute top-1 left-1 px-1 rounded-sm bg-black/70 text-[9px] font-mono text-violet-100/80 tabular-nums pointer-events-none">
                      {durLabel}
                    </span>
                  )}

                  {/* Extend → video-edit */}
                  {canExtend && (
                    <button
                      type="button"
                      disabled={!extendEnabled}
                      onClick={() => extendEnabled && onExtend?.(tile)}
                      title={extendEnabled ? 'Extend this clip (video-edit)' : extendHint}
                      className={cn(
                        'absolute bottom-1 right-1 z-10 flex items-center gap-0.5 px-1.5 h-5 rounded',
                        'bg-black/75 border border-violet-400/40 text-[9px] font-mono font-bold tracking-wider',
                        'opacity-0 group-hover:opacity-100 transition-opacity',
                        extendEnabled
                          ? 'text-violet-200 hover:text-white hover:border-violet-300/70'
                          : 'text-violet-200/40 cursor-not-allowed',
                      )}
                    >
                      <CornerDownRight className="w-2.5 h-2.5" />
                      EXTEND
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </GenSection>
  );
}
