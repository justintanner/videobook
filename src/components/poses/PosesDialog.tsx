import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Users, Loader2, Zap, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import {
  POSE_PLATFORMS,
  POSE_MODEL_OPTIONS,
  POSE_PROVIDERS,
  POSE_COUNT_MIN,
  POSE_COUNT_MAX,
  POSE_COUNT_DEFAULT,
  type PosePlatform,
  type PoseModelKey,
  type PoseProvider,
  type UseGeneratePosesResult,
} from '@/hooks/useGeneratePoses';

const PLATFORM_LABELS: Record<PosePlatform, string> = {
  ig: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

interface PosesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageAssets: MediaItem[];
  projectSlug: string | undefined;
  initialSlug: string | null;
  generate: UseGeneratePosesResult['generate'];
  submitting: boolean;
}

export function PosesDialog({
  open,
  onOpenChange,
  imageAssets,
  projectSlug,
  initialSlug,
  generate,
  submitting,
}: PosesDialogProps) {
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<PosePlatform>>(new Set(['ig']));
  const [selectedModels, setSelectedModels] = useState<Set<PoseModelKey>>(new Set(['nano_banana_pro']));
  const [selectedProvider, setSelectedProvider] = useState<PoseProvider>('kie');
  const [posesPerPlatform, setPosesPerPlatform] = useState<number>(POSE_COUNT_DEFAULT);

  // Seed selections when the dialog opens
  useEffect(() => {
    if (!open) return;
    const normalized = initialSlug?.replace(/^@/, '').trim();
    const initial = normalized && imageAssets.some((a) => a.id === normalized)
      ? new Set([normalized])
      : new Set<string>();
    setSelectedSources(initial);
    setSelectedPlatforms(new Set(['ig']));
    setSelectedModels(new Set(['nano_banana_pro']));
    setSelectedProvider('kie');
    setPosesPerPlatform(POSE_COUNT_DEFAULT);
    // Reset only when open transitions to true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleSource = useCallback((id: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const togglePlatform = useCallback((p: PosePlatform) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }, []);

  const toggleModel = useCallback((m: PoseModelKey) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  }, []);

  const jobCount = useMemo(
    () => selectedSources.size * selectedPlatforms.size * selectedModels.size * posesPerPlatform,
    [selectedSources.size, selectedPlatforms.size, selectedModels.size, posesPerPlatform],
  );

  const canSubmit = !submitting
    && !!projectSlug
    && selectedSources.size > 0
    && selectedPlatforms.size > 0
    && selectedModels.size > 0
    && posesPerPlatform >= POSE_COUNT_MIN
    && posesPerPlatform <= POSE_COUNT_MAX;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !projectSlug) return;
    const res = await generate({
      sourceSlugs: [...selectedSources],
      platforms: [...selectedPlatforms],
      models: [...selectedModels],
      provider: selectedProvider,
      posesPerPlatform,
      projectSlug,
    });
    if (res) onOpenChange(false);
  }, [canSubmit, projectSlug, generate, selectedSources, selectedPlatforms, selectedModels, selectedProvider, posesPerPlatform, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(760px,94vw)] max-h-[86vh] -translate-x-1/2 -translate-y-1/2',
            'rounded border border-amber-500/30 bg-black/95 backdrop-blur-sm',
            'shadow-[0_0_48px_rgba(245,158,11,0.15)] text-amber-200',
            'flex flex-col overflow-hidden',
          )}
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-amber-500/30 bg-amber-500/5">
            <Dialog.Title className="flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-widest text-amber-300">
              <Users className="w-3.5 h-3.5" />
              Generate Poses
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                tabIndex={-1}
                className="w-6 h-6 flex items-center justify-center text-amber-400/60 hover:text-amber-200 rounded hover:bg-amber-500/10"
              >
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
            {/* Sources */}
            <section>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70">
                  Source Images
                </h3>
                <span className="text-[10px] font-mono text-amber-500/50 tabular-nums">
                  {selectedSources.size} / {imageAssets.length}
                </span>
              </div>
              {imageAssets.length === 0 ? (
                <div className="text-[11px] font-mono text-amber-500/50 italic px-2 py-4 rounded border border-dashed border-amber-500/20">
                  No image assets in this project yet.
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
                  {imageAssets.map((a) => {
                    const selected = selectedSources.has(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => toggleSource(a.id)}
                        disabled={submitting}
                        title={a.slug}
                        className={cn(
                          'relative aspect-square rounded overflow-hidden border transition-all duration-150',
                          'disabled:opacity-50 disabled:cursor-not-allowed',
                          selected
                            ? 'border-amber-400 ring-2 ring-amber-400/60'
                            : 'border-amber-500/20 hover:border-amber-400/50',
                        )}
                      >
                        {a.thumbnailSrc ? (
                          <img src={a.thumbnailSrc} alt={a.slug} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full bg-amber-500/5" />
                        )}
                        <div className={cn(
                          'absolute inset-x-0 bottom-0 px-1.5 py-0.5 text-[9px] font-mono truncate',
                          selected ? 'bg-amber-500/80 text-black' : 'bg-black/70 text-amber-200/80',
                        )}>
                          {a.slug}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Platforms */}
            <section>
              <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70 mb-2">
                Target Platforms
              </h3>
              <div className="flex flex-wrap gap-2">
                {POSE_PLATFORMS.map((p) => {
                  const selected = selectedPlatforms.has(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePlatform(p)}
                      disabled={submitting}
                      className={cn(
                        'h-7 px-3 rounded border transition-colors duration-150',
                        'text-[11px] font-mono font-bold uppercase tracking-wider',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        selected
                          ? 'bg-amber-500/20 border-amber-400 text-amber-100'
                          : 'bg-transparent border-amber-500/30 text-amber-300/70 hover:border-amber-400/60 hover:text-amber-200',
                      )}
                    >
                      {PLATFORM_LABELS[p]}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Provider */}
            <section>
              <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70 mb-2">
                Provider
              </h3>
              <div className="flex flex-wrap gap-2">
                {POSE_PROVIDERS.map((p) => {
                  const selected = selectedProvider === p.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setSelectedProvider(p.key)}
                      disabled={submitting}
                      className={cn(
                        'h-7 px-3 rounded border transition-colors duration-150',
                        'text-[11px] font-mono font-bold uppercase tracking-wider',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        selected
                          ? 'bg-amber-500/20 border-amber-400 text-amber-100'
                          : 'bg-transparent border-amber-500/30 text-amber-300/70 hover:border-amber-400/60 hover:text-amber-200',
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Poses per platform */}
            <section>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70">
                  Poses per Platform
                </h3>
                <span className="text-[10px] font-mono text-amber-500/50 tabular-nums">
                  {POSE_COUNT_MIN}–{POSE_COUNT_MAX}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: POSE_COUNT_MAX - POSE_COUNT_MIN + 1 }, (_, i) => i + POSE_COUNT_MIN).map((n) => {
                  const selected = posesPerPlatform === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setPosesPerPlatform(n)}
                      disabled={submitting}
                      className={cn(
                        'h-7 w-9 rounded border transition-colors duration-150',
                        'text-[11px] font-mono font-bold tabular-nums',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        selected
                          ? 'bg-amber-500/20 border-amber-400 text-amber-100'
                          : 'bg-transparent border-amber-500/30 text-amber-300/70 hover:border-amber-400/60 hover:text-amber-200',
                      )}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Models */}
            <section>
              <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70 mb-2">
                Image Models
              </h3>
              <div className="flex flex-wrap gap-2">
                {POSE_MODEL_OPTIONS.map((m) => {
                  const selected = selectedModels.has(m.key);
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => toggleModel(m.key)}
                      disabled={submitting}
                      className={cn(
                        'h-7 px-3 rounded border transition-colors duration-150',
                        'text-[11px] font-mono font-bold tracking-wider',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        selected
                          ? 'bg-amber-500/20 border-amber-400 text-amber-100'
                          : 'bg-transparent border-amber-500/30 text-amber-300/70 hover:border-amber-400/60 hover:text-amber-200',
                      )}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-amber-500/30 bg-amber-500/5">
            <div className="text-[11px] font-mono text-amber-300/80 tabular-nums">
              <span className="text-amber-200 font-bold">{jobCount}</span> image{jobCount === 1 ? '' : 's'} will be queued
              {jobCount > 0 && (
                <span className="text-amber-500/50 ml-1">
                  ({selectedSources.size}×{selectedPlatforms.size}×{selectedModels.size}×{posesPerPlatform})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={submitting}
                  className={cn(
                    'h-7 px-3 rounded border border-amber-500/30 text-amber-300/80',
                    'text-[11px] font-mono font-bold uppercase tracking-wider',
                    'hover:bg-amber-500/10 hover:text-amber-200',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className={cn(
                  'h-7 px-3 flex items-center gap-1.5 rounded',
                  'text-[11px] font-mono font-bold uppercase tracking-wider',
                  'text-amber-100 bg-amber-500/25 border border-amber-400/70 hover:bg-amber-500/40 hover:border-amber-300',
                  'transition-colors duration-150',
                  'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-amber-500/25',
                )}
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                Generate
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
