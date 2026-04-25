import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Zap, AlertTriangle, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import {
  OUTFIT_ASPECT_RATIOS,
  OUTFIT_MODEL_OPTIONS,
  type OutfitAspectRatio,
  type OutfitModelKey,
  type UseGenerateOutfitResult,
} from '@/hooks/useGenerateOutfit';
import { usePoseExtract } from '@/hooks/usePoseExtract';
import { usePoseDescription } from '@/hooks/usePoseDescription';
import { useOutfitPromptPreview } from '@/hooks/useOutfitPromptPreview';
import type { UseMcpResult } from 'use-mcp/react';

const DEFAULT_MODELS: OutfitModelKey[] = OUTFIT_MODEL_OPTIONS.map((m) => m.key);

interface CharacterComposeRailProps {
  characterId: string;
  projectSlug: string | undefined;
  outfits: MediaItem[];
  wardrobe: MediaItem[];
  poses: MediaItem[];
  backdrop: MediaItem[];
  onSelectAsset: (assetId: string) => void;
  onUnpin: (slot: 'wardrobe' | 'poses' | 'backdrop' | 'outfits', assetId: string) => void;
  onPickWardrobe: () => void;
  onPickPose: () => void;
  onPickBackdrop: () => void;
  generate: UseGenerateOutfitResult['generate'];
  submitting: boolean;
  callTool: UseMcpResult['callTool'];
  callState: UseMcpResult['state'];
}

export function CharacterComposeRail({
  characterId,
  projectSlug,
  outfits,
  wardrobe,
  poses,
  backdrop,
  onSelectAsset,
  onUnpin,
  onPickWardrobe,
  onPickPose,
  onPickBackdrop,
  generate,
  submitting,
  callTool,
  callState,
}: CharacterComposeRailProps) {
  const [selectedModels, setSelectedModels] = useState<Set<OutfitModelKey>>(
    () => new Set(DEFAULT_MODELS),
  );
  const [aspectRatio, setAspectRatio] = useState<OutfitAspectRatio>('9:16');

  const garment = wardrobe[0] ?? null;
  const pose = poses[0] ?? null;
  const backdropItem = backdrop[0] ?? null;

  const aspectRatioNum = useMemo(() => {
    const [w, h] = aspectRatio.split(':').map(Number);
    return w / h;
  }, [aspectRatio]);

  const {
    extract: extractPose,
    reset: resetPose,
    result: poseResult,
    loading: poseLoading,
    error: poseError,
  } = usePoseExtract(aspectRatioNum);

  useEffect(() => {
    if (!pose) {
      resetPose();
      return;
    }
    const url = pose.filePath ?? pose.thumbnailSrc ?? '';
    if (!url) return;
    extractPose(pose.id, url);
  }, [pose, extractPose, resetPose]);

  const { poseDescription, shot } = usePoseDescription({
    callTool,
    callState,
    projectSlug,
    poseSlug: pose?.id ?? null,
  });

  const modelsArray = useMemo(() => [...selectedModels], [selectedModels]);

  const { prompts: previewPrompts, loading: previewLoading, error: previewError } = useOutfitPromptPreview({
    callTool,
    callState,
    projectSlug: projectSlug ?? null,
    modelImageSlug: characterId,
    models: modelsArray,
    provider: 'kie',
    hasBackdrop: !!backdropItem,
    poseDescription,
    shot,
    platform: null,
    poseCoverage: poseResult?.coverage ?? null,
  });

  const toggleModel = useCallback((key: OutfitModelKey) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const canSubmit =
    !submitting &&
    !!projectSlug &&
    !!garment &&
    !!pose &&
    !!poseResult &&
    !poseLoading &&
    !poseError &&
    selectedModels.size > 0;

  const handleGenerate = useCallback(async () => {
    if (!canSubmit || !projectSlug || !garment || !pose || !poseResult) return;
    await generate({
      projectSlug,
      modelImageSlug: characterId,
      garmentImageSlug: garment.id,
      backdropImageSlug: backdropItem?.id,
      poseSkeletonBlob: poseResult.skeleton.blob,
      poseSkeletonFilename: `pose-skeleton-${pose.id}.png`,
      poseCoverage: poseResult.coverage,
      poseDescription: poseDescription ?? undefined,
      shot: shot ?? undefined,
      models: [...selectedModels],
      provider: 'kie',
      aspectRatio,
    });
  }, [
    canSubmit,
    projectSlug,
    characterId,
    garment,
    pose,
    backdropItem,
    poseResult,
    poseDescription,
    shot,
    selectedModels,
    generate,
    aspectRatio,
  ]);

  const activePreviewModel: OutfitModelKey | null = modelsArray[0] ?? null;
  const activePreviewEntry = activePreviewModel
    ? previewPrompts.find((p) => p.model === activePreviewModel) ?? null
    : null;

  return (
    <aside className="w-80 shrink-0 border-l border-violet-500/20 overflow-y-auto bg-black/40 flex flex-col">
      {outfits.length > 0 ? (
        <div className="border-b border-violet-500/20 px-3 py-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70">
              Outfits
            </span>
            <span className="text-[9px] font-mono text-violet-400/40">{outfits.length}</span>
          </div>
          <div className="flex gap-1.5 overflow-x-auto items-stretch">
            {outfits.map((it) => (
              <Thumb
                key={it.id}
                item={it}
                onSelect={onSelectAsset}
                onUnpin={(id) => onUnpin('outfits', id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="border-t border-zinc-700/40 px-3 py-2 grid grid-cols-3 gap-2">
        <SingleSlot
          label="Wardrobe"
          item={garment}
          emptyLabel="Pick garment"
          onPick={onPickWardrobe}
          onUnpin={(id) => onUnpin('wardrobe', id)}
        />
        <SingleSlot
          label="Pose"
          item={pose}
          emptyLabel="Pick pose"
          onPick={onPickPose}
          onUnpin={(id) => onUnpin('poses', id)}
          skeletonOverlay={poseResult?.skeleton.dataUrl ?? null}
        />
        <SingleSlot
          label="Backdrop"
          item={backdropItem}
          emptyLabel="Add backdrop"
          onPick={onPickBackdrop}
          onUnpin={(id) => onUnpin('backdrop', id)}
        />
      </div>
      {pose && (poseResult || poseLoading || poseError) ? (
        <div className="border-t border-violet-500/20 px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70">
              Pose skeleton
            </span>
            {poseLoading ? (
              <Loader2 className="w-3 h-3 animate-spin text-violet-300/60" />
            ) : poseResult ? (
              <span className="text-[9px] font-mono text-emerald-300/70 uppercase tracking-wider">
                {poseResult.coverage}
              </span>
            ) : null}
          </div>
          {poseError ? (
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-red-300/80">
              <AlertTriangle className="w-3 h-3" /> {poseError}
            </div>
          ) : poseResult ? (
            <div className="rounded border border-violet-500/20 bg-black/60 overflow-hidden flex items-center justify-center h-32">
              <img
                src={poseResult.skeleton.dataUrl}
                alt="extracted pose skeleton"
                className="max-h-full max-w-full object-contain"
                draggable={false}
              />
            </div>
          ) : (
            <div className="text-[9px] font-mono text-violet-400/50">extracting…</div>
          )}
        </div>
      ) : null}

      <div className="border-t border-violet-500/20 px-3 py-2">
        <div className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70 mb-1.5">
          Aspect ratio
        </div>
        <div className="flex gap-1">
          {OUTFIT_ASPECT_RATIOS.map((r) => {
            const active = aspectRatio === r;
            return (
              <button
                key={r}
                type="button"
                onClick={() => setAspectRatio(r)}
                className={cn(
                  'flex-1 px-2 py-1 rounded border text-[10px] font-mono font-bold uppercase tracking-wider transition-colors',
                  active
                    ? 'border-violet-300 bg-violet-500/20 text-violet-100'
                    : 'border-violet-500/20 text-violet-300/60 hover:border-violet-400/50',
                )}
              >
                {r}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-violet-500/20 px-3 py-2">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70">
            Prompt
          </span>
          {previewLoading ? (
            <Loader2 className="w-3 h-3 animate-spin text-violet-300/60" />
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1 mb-1.5">
          {OUTFIT_MODEL_OPTIONS.map((m) => {
            const active = selectedModels.has(m.key);
            const isPreviewing = m.key === activePreviewModel;
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => toggleModel(m.key)}
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase tracking-wider transition-colors',
                  active
                    ? isPreviewing
                      ? 'border-violet-200 bg-violet-500/30 text-violet-50'
                      : 'border-violet-300 bg-violet-500/15 text-violet-100'
                    : 'border-violet-500/20 text-violet-300/50 hover:border-violet-400/50',
                )}
              >
                <span
                  className={cn(
                    'w-3 h-3 rounded-sm border flex items-center justify-center shrink-0',
                    active ? 'border-violet-200 bg-violet-400/30' : 'border-violet-500/40',
                  )}
                >
                  {active ? <Check className="w-2 h-2" strokeWidth={3} /> : null}
                </span>
                {m.label}
              </button>
            );
          })}
        </div>
        {previewError ? (
          <div className="flex items-center gap-1.5 text-[9px] font-mono text-red-300/80">
            <AlertTriangle className="w-3 h-3" /> {previewError}
          </div>
        ) : modelsArray.length === 0 ? (
          <div className="text-[9px] font-mono text-violet-400/50">Select at least one model.</div>
        ) : !activePreviewEntry ? (
          <div className="text-[9px] font-mono text-violet-400/50">Computing…</div>
        ) : (
          <div
            className={cn(
              'rounded border border-violet-500/20 bg-black/40 p-2 text-[10px] font-mono text-violet-200/80 whitespace-pre-wrap break-words max-h-72 overflow-y-auto',
              previewLoading && 'opacity-60',
            )}
          >
            {activePreviewEntry.prompt}
          </div>
        )}
      </div>

      <div className="border-t border-violet-500/30 px-3 py-3 mt-auto bg-violet-500/5">
        <div className="mb-2 px-1">
          <PoseStatus
            loading={poseLoading}
            error={poseError}
            ready={!!poseResult}
            hasPose={!!pose}
            modelCount={selectedModels.size}
            aspectRatio={aspectRatio}
          />
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canSubmit}
          className={cn(
            'w-full relative overflow-hidden flex items-center justify-center gap-2 px-3 py-3 rounded text-[12px] font-mono font-bold uppercase tracking-wider transition-colors',
            canSubmit
              ? 'bg-violet-500 text-white hover:bg-violet-400 shadow-lg shadow-violet-500/30'
              : 'bg-zinc-800 border border-zinc-700 text-zinc-500 cursor-not-allowed',
          )}
        >
          {canSubmit ? (
            <span className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/25 to-transparent pointer-events-none" />
          ) : null}
          {submitting ? <Loader2 className="w-4 h-4 animate-spin relative" /> : <Zap className="w-4 h-4 relative" />}
          <span className="relative">{submitting ? 'Enqueuing…' : 'Generate image'}</span>
        </button>
      </div>
    </aside>
  );
}

interface SingleSlotProps {
  label: string;
  item: MediaItem | null;
  emptyLabel: string;
  onPick: () => void;
  onUnpin: (assetId: string) => void;
  skeletonOverlay?: string | null;
}

function SingleSlot({ label, item, emptyLabel, onPick, onUnpin, skeletonOverlay }: SingleSlotProps) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70 mb-1">
        {label}
      </div>
      {item ? (
        <div className="group relative w-full aspect-square">
          <button
            type="button"
            onClick={onPick}
            title={item.slug}
            className="w-full h-full rounded border border-violet-500/20 hover:border-violet-300 overflow-hidden bg-black transition-colors"
          >
            {item.thumbnailSrc || item.filePath ? (
              <img
                src={item.thumbnailSrc || item.filePath}
                alt={item.title}
                className="w-full h-full object-cover"
                draggable={false}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[8px] font-mono text-violet-400/60 px-1 text-center">
                {item.slug}
              </div>
            )}
          </button>
          {skeletonOverlay ? (
            <div className="pointer-events-none absolute bottom-1 right-1 w-8 h-8 rounded border border-emerald-400/60 bg-black/80 overflow-hidden">
              <img src={skeletonOverlay} alt="pose skeleton" className="w-full h-full object-contain" draggable={false} />
            </div>
          ) : null}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onUnpin(item.id);
            }}
            aria-label={`Clear ${label.toLowerCase()}`}
            className={cn(
              'absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-900 border border-violet-400/40 text-violet-200',
              'opacity-0 group-hover:opacity-100 hover:bg-red-500/40 hover:border-red-400 transition-opacity',
              'flex items-center justify-center',
            )}
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onPick}
          className="w-full aspect-square rounded border border-dashed border-violet-400/60 bg-violet-500/10 text-violet-100 hover:bg-violet-500/25 hover:border-violet-300 flex items-center justify-center gap-1.5 transition-colors"
        >
          <span className="text-[9px] font-mono font-bold uppercase tracking-wider px-1 text-center leading-tight">
            {emptyLabel}
          </span>
        </button>
      )}
    </div>
  );
}

function Thumb({
  item,
  onSelect,
  onUnpin,
}: {
  item: MediaItem;
  onSelect: (assetId: string) => void;
  onUnpin: (assetId: string) => void;
}) {
  const thumb = item.thumbnailSrc || item.filePath;
  return (
    <div className="group relative shrink-0 w-16 h-16">
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        title={item.slug}
        className="w-full h-full rounded border border-violet-500/20 hover:border-violet-300 overflow-hidden bg-black transition-colors"
      >
        {thumb ? (
          <img src={thumb} alt={item.title} className="w-full h-full object-cover" draggable={false} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[8px] font-mono text-violet-400/60 px-1 text-center">
            {item.slug}
          </div>
        )}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUnpin(item.id);
        }}
        aria-label={`Unpin ${item.slug}`}
        className={cn(
          'absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-900 border border-violet-400/40 text-violet-200',
          'opacity-0 group-hover:opacity-100 hover:bg-red-500/40 hover:border-red-400 transition-opacity',
          'flex items-center justify-center',
        )}
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

function PoseStatus({
  loading,
  error,
  ready,
  hasPose,
  modelCount,
  aspectRatio,
}: {
  loading: boolean;
  error: string | null;
  ready: boolean;
  hasPose: boolean;
  modelCount: number;
  aspectRatio: OutfitAspectRatio;
}) {
  const tail = ` · ${modelCount} image${modelCount === 1 ? '' : 's'} via Kie · ${aspectRatio}`;
  if (!hasPose) {
    return (
      <div className="text-[9px] font-mono text-violet-400/50">Pin a pose to enable generate.</div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-[9px] font-mono text-violet-300/70">
        <Loader2 className="w-3 h-3 animate-spin" /> extracting pose skeleton…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-[9px] font-mono text-red-300/80">
        <AlertTriangle className="w-3 h-3" /> {error}
      </div>
    );
  }
  if (ready) {
    return (
      <div className="text-[9px] font-mono text-emerald-300/70">skeleton ready{tail}</div>
    );
  }
  return null;
}
