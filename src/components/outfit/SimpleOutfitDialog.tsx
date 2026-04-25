import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Zap, X, AlertTriangle, Shirt } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import {
  OUTFIT_MODEL_OPTIONS,
  type OutfitModelKey,
  type UseGenerateOutfitResult,
} from '@/hooks/useGenerateOutfit';
import { usePoseExtract } from '@/hooks/usePoseExtract';
import { usePoseDescription } from '@/hooks/usePoseDescription';
import type { UseMcpResult } from 'use-mcp/react';

const DEFAULT_MODELS: OutfitModelKey[] = OUTFIT_MODEL_OPTIONS.map((m) => m.key);

interface SimpleOutfitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  character: { id: string; slug: string } | null;
  wardrobe: MediaItem[];
  poses: MediaItem[];
  projectSlug: string | undefined;
  generate: UseGenerateOutfitResult['generate'];
  submitting: boolean;
  callTool: UseMcpResult['callTool'];
  callState: UseMcpResult['state'];
}

export function SimpleOutfitDialog({
  open,
  onOpenChange,
  character,
  wardrobe,
  poses,
  projectSlug,
  generate,
  submitting,
  callTool,
  callState,
}: SimpleOutfitDialogProps) {
  const [garmentId, setGarmentId] = useState<string | null>(null);
  const [poseId, setPoseId] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Set<OutfitModelKey>>(
    () => new Set(DEFAULT_MODELS),
  );

  // Aspect ratio is fixed at 9:16 for the simple flow.
  const { extract: extractPose, reset: resetPose, result: poseResult, loading: poseLoading, error: poseError } =
    usePoseExtract(9 / 16);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setGarmentId(null);
    setPoseId(null);
    setSelectedModels(new Set(DEFAULT_MODELS));
    resetPose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleModel = useCallback((key: OutfitModelKey) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectedPose = useMemo(() => poses.find((p) => p.id === poseId) ?? null, [poses, poseId]);

  // Run skeleton extraction when pose changes
  useEffect(() => {
    if (!open) return;
    if (!selectedPose) {
      resetPose();
      return;
    }
    const url = selectedPose.filePath ?? selectedPose.thumbnailSrc ?? '';
    if (!url) return;
    extractPose(selectedPose.id, url);
  }, [open, selectedPose, extractPose, resetPose]);

  const { poseDescription, shot } = usePoseDescription({
    callTool,
    callState,
    projectSlug,
    poseSlug: poseId,
  });

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const canSubmit =
    !submitting &&
    !!projectSlug &&
    !!character &&
    !!garmentId &&
    !!selectedPose &&
    !!poseResult &&
    !poseLoading &&
    !poseError &&
    selectedModels.size > 0;

  const handleGenerate = useCallback(async () => {
    if (
      !canSubmit ||
      !projectSlug ||
      !character ||
      !garmentId ||
      !selectedPose ||
      !poseResult
    )
      return;
    const ok = await generate({
      projectSlug,
      modelImageSlug: character.id,
      garmentImageSlug: garmentId,
      poseSkeletonBlob: poseResult.skeleton.blob,
      poseSkeletonFilename: `pose-skeleton-${selectedPose.id}.png`,
      poseCoverage: poseResult.coverage,
      poseDescription: poseDescription ?? undefined,
      shot: shot ?? undefined,
      models: [...selectedModels],
      provider: 'kie',
      aspectRatio: '9:16',
    });
    if (ok) onOpenChange(false);
  }, [
    canSubmit,
    projectSlug,
    character,
    garmentId,
    selectedPose,
    poseResult,
    poseDescription,
    shot,
    selectedModels,
    generate,
    onOpenChange,
  ]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100]"
        onClick={() => onOpenChange(false)}
      />
      <div
        role="dialog"
        aria-label="Compose outfit"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] w-[min(640px,calc(100vw-2rem))] max-h-[calc(100vh-3rem)] flex flex-col bg-zinc-950 border border-violet-500/30 rounded-md shadow-2xl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-violet-500/20 shrink-0">
          <div className="flex items-center gap-2 text-[11px] font-mono font-bold tracking-widest text-violet-300 uppercase">
            <Shirt className="w-3.5 h-3.5" />
            Compose outfit{character ? ` — ${character.slug}` : ''}
          </div>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onOpenChange(false)}
            className="text-violet-400/70 hover:text-violet-100 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
          <PickerRow
            label="Garment"
            emptyHint="Pin a garment to this character's wardrobe first."
            items={wardrobe}
            selectedId={garmentId}
            onSelect={setGarmentId}
            disabled={submitting}
          />

          <PickerRow
            label="Pose"
            emptyHint="Pin a pose reference to this character first."
            items={poses}
            selectedId={poseId}
            onSelect={setPoseId}
            disabled={submitting}
            footer={
              selectedPose ? (
                <PoseStatus loading={poseLoading} error={poseError} ready={!!poseResult} />
              ) : null
            }
          />

          <section>
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-violet-300/80">
                Models
              </h3>
              <span className="text-[10px] font-mono text-violet-500/50">
                {selectedModels.size} selected
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {OUTFIT_MODEL_OPTIONS.map((m) => {
                const isSelected = selectedModels.has(m.key);
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
                      isSelected
                        ? 'bg-violet-500/20 border-violet-400 text-violet-100'
                        : 'bg-transparent border-violet-500/30 text-violet-300/70 hover:border-violet-400/60 hover:text-violet-200',
                    )}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-violet-500/20 shrink-0">
          <div className="text-[10px] font-mono text-violet-400/70 tabular-nums">
            <span className="text-violet-200 font-bold">{selectedModels.size}</span> image{selectedModels.size === 1 ? '' : 's'} via Kie · 9:16
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className={cn(
                'h-7 px-3 rounded border border-violet-500/30 text-violet-300/80',
                'text-[11px] font-mono font-bold uppercase tracking-wider',
                'hover:bg-violet-500/10 hover:text-violet-100',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canSubmit}
              className={cn(
                'h-7 px-3 flex items-center gap-1.5 rounded',
                'text-[11px] font-mono font-bold uppercase tracking-wider',
                'text-violet-100 bg-violet-500/25 border border-violet-400/70 hover:bg-violet-500/40 hover:border-violet-300',
                'transition-colors duration-150',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-500/25',
              )}
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Generate
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

interface PickerRowProps {
  label: string;
  emptyHint: string;
  items: MediaItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
  footer?: React.ReactNode;
}

function PickerRow({ label, emptyHint, items, selectedId, onSelect, disabled, footer }: PickerRowProps) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-violet-300/80">
          {label}
        </h3>
        <span className="text-[10px] font-mono text-violet-500/50">
          {items.length} option{items.length === 1 ? '' : 's'}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] font-mono text-violet-400/60 italic px-3 py-3 rounded border border-dashed border-violet-500/25">
          {emptyHint}
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {items.map((it) => {
            const thumb = it.thumbnailSrc || it.filePath || '';
            const isSelected = selectedId === it.id;
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => onSelect(it.id)}
                disabled={disabled}
                title={it.slug}
                className={cn(
                  'relative shrink-0 w-20 h-20 rounded overflow-hidden border transition-all duration-150',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  isSelected
                    ? 'border-violet-300 ring-2 ring-violet-300/60'
                    : 'border-violet-500/25 hover:border-violet-400/60',
                )}
              >
                {thumb ? (
                  <img src={thumb} alt={it.slug} className="w-full h-full object-cover" draggable={false} />
                ) : (
                  <div className="w-full h-full bg-violet-500/5 flex items-center justify-center text-[8px] font-mono text-violet-300/60 px-1 text-center">
                    {it.slug}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
      {footer}
    </section>
  );
}

function PoseStatus({ loading, error, ready }: { loading: boolean; error: string | null; ready: boolean }) {
  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[10px] font-mono text-violet-300/70">
        <Loader2 className="w-3 h-3 animate-spin" /> extracting skeleton…
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[10px] font-mono text-red-300/80">
        <AlertTriangle className="w-3 h-3" /> {error}
      </div>
    );
  }
  if (ready) {
    return (
      <div className="mt-2 text-[10px] font-mono text-emerald-300/70">skeleton ready</div>
    );
  }
  return null;
}
