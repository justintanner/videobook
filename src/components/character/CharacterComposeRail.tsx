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
  wardrobe: MediaItem[];
  poses: MediaItem[];
  backdrop: MediaItem[];
  onUnpin: (slot: 'wardrobe' | 'poses' | 'backdrop', assetId: string) => void;
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
  wardrobe,
  poses,
  backdrop,
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
  const [previewModel, setPreviewModel] = useState<OutfitModelKey>(DEFAULT_MODELS[0]);
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

  // Always include the previewed model in the prompt fetch — even if it's
  // unchecked for generation, the user still wants to read its prompt.
  const previewModelsArray = useMemo(() => {
    if (selectedModels.has(previewModel)) return modelsArray;
    return [...modelsArray, previewModel];
  }, [modelsArray, selectedModels, previewModel]);

  const { prompts: previewPrompts, loading: previewLoading, error: previewError } = useOutfitPromptPreview({
    callTool,
    callState,
    projectSlug: projectSlug ?? null,
    modelImageSlug: characterId,
    models: previewModelsArray,
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

  const activePreviewEntry = previewPrompts.find((p) => p.model === previewModel) ?? null;

  return (
    <aside className="w-[26rem] shrink-0 border-l border-violet-500/20 overflow-y-auto bg-black/40 flex flex-col">
      <div className="px-4 py-3 grid grid-cols-4 gap-2.5">
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
        />
        <SingleSlot
          label="Backdrop"
          item={backdropItem}
          emptyLabel="Add backdrop"
          onPick={onPickBackdrop}
          onUnpin={(id) => onUnpin('backdrop', id)}
        />
        <SkeletonSlot
          hasPose={!!pose}
          loading={poseLoading}
          error={poseError}
          dataUrl={poseResult?.skeleton.dataUrl ?? null}
          coverage={poseResult?.coverage ?? null}
        />
      </div>

      <div className="border-t border-violet-500/20 px-4 py-3">
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

      <div className="border-t border-violet-500/20 px-4 py-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70">
            Prompt
          </span>
          {previewLoading ? (
            <Loader2 className="w-3 h-3 animate-spin text-violet-300/60" />
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 mb-2">
          {OUTFIT_MODEL_OPTIONS.map((m) => {
            const active = selectedModels.has(m.key);
            const isPreviewing = m.key === previewModel;
            return (
              <div
                key={m.key}
                className={cn(
                  'flex items-stretch rounded border text-[9px] font-mono uppercase tracking-wider transition-colors overflow-hidden',
                  isPreviewing
                    ? 'border-violet-200 bg-violet-500/30'
                    : active
                      ? 'border-violet-300 bg-violet-500/15'
                      : 'border-violet-500/20',
                )}
              >
                <button
                  type="button"
                  onClick={() => toggleModel(m.key)}
                  title={active ? `Disable ${m.label} for generation` : `Enable ${m.label} for generation`}
                  className={cn(
                    'flex items-center justify-center px-2 border-r',
                    isPreviewing
                      ? 'border-violet-200/50 hover:bg-violet-500/40'
                      : active
                        ? 'border-violet-300/40 hover:bg-violet-500/25'
                        : 'border-violet-500/20 hover:bg-violet-500/10',
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
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewModel(m.key)}
                  title={`Show ${m.label} prompt`}
                  className={cn(
                    'px-3 py-1.5',
                    isPreviewing
                      ? 'text-violet-50'
                      : active
                        ? 'text-violet-100 hover:bg-violet-500/20'
                        : 'text-violet-300/50 hover:bg-violet-500/10',
                  )}
                >
                  {m.label}
                </button>
              </div>
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
              'rounded border border-violet-500/20 bg-black/40 p-2 text-[12px] leading-snug font-mono text-violet-200/80 whitespace-pre-wrap break-words max-h-44 overflow-y-auto',
              previewLoading && 'opacity-60',
            )}
          >
            {activePreviewEntry.prompt}
          </div>
        )}
      </div>

      <div className="sticky bottom-0 border-t border-violet-500/30 px-4 py-3 mt-auto bg-violet-500/5 backdrop-blur">
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
}

function SingleSlot({ label, item, emptyLabel, onPick, onUnpin }: SingleSlotProps) {
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

interface SkeletonSlotProps {
  hasPose: boolean;
  loading: boolean;
  error: string | null;
  dataUrl: string | null;
  coverage: 'face' | 'upper' | 'full' | null;
}

function SkeletonSlot({ hasPose, loading, error, dataUrl, coverage }: SkeletonSlotProps) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70 mb-1">
        Skeleton
      </div>
      <div
        className="relative w-full aspect-square rounded border border-violet-500/20 bg-black/60 overflow-hidden flex items-center justify-center"
        title={coverage ? `coverage: ${coverage}` : undefined}
      >
        {!hasPose ? (
          <span className="text-[8px] font-mono text-violet-400/50 px-1 text-center leading-tight">
            Pin a pose
          </span>
        ) : loading ? (
          <Loader2 className="w-4 h-4 animate-spin text-violet-300/60" />
        ) : error ? (
          <div className="flex flex-col items-center gap-1 text-red-300/80 px-1">
            <AlertTriangle className="w-3 h-3" />
            <span className="text-[8px] font-mono text-center leading-tight">extract failed</span>
          </div>
        ) : dataUrl ? (
          <>
            <img
              src={dataUrl}
              alt="extracted pose skeleton"
              className="w-full h-full object-contain"
              draggable={false}
            />
            {coverage ? (
              <span className="absolute bottom-1 right-1 text-[8px] font-mono uppercase tracking-wider text-emerald-300/90 bg-black/70 rounded px-1">
                {coverage}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-[8px] font-mono text-violet-400/50">extracting…</span>
        )}
      </div>
    </div>
  );
}

