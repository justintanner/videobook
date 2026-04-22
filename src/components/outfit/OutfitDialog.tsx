import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Shirt, Loader2, Zap, X, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import {
  POSE_MODEL_OPTIONS,
  POSE_PLATFORMS,
  POSE_PROVIDERS,
  type PoseModelKey,
  type PosePlatform,
  type PoseProvider,
} from '@/hooks/useGeneratePoses';

const PLATFORM_LABELS: Record<PosePlatform, string> = {
  ig: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};
import {
  OUTFIT_CUSTOM_PROMPT_MAX,
  type UseGenerateOutfitResult,
} from '@/hooks/useGenerateOutfit';
import { useBlazePose } from '@/hooks/useBlazePose';

type SlotKind = 'model' | 'garment' | 'pose';

interface ImageChoice {
  assetId: string;
  slug: string;
  fullUrl: string;
  thumbUrl: string;
}

interface OutfitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageAssets: MediaItem[];
  projectSlug: string | undefined;
  initialSlug: string | null;
  generate: UseGenerateOutfitResult['generate'];
  submitting: boolean;
}

function mediaItemToChoice(item: MediaItem): ImageChoice {
  return {
    assetId: item.id,
    slug: item.slug,
    fullUrl: item.filePath || item.thumbnailSrc || '',
    thumbUrl: item.thumbnailSrc || item.filePath || '',
  };
}

export function OutfitDialog({
  open,
  onOpenChange,
  imageAssets,
  projectSlug,
  initialSlug,
  generate,
  submitting,
}: OutfitDialogProps) {
  const [model, setModel] = useState<ImageChoice | null>(null);
  const [garment, setGarment] = useState<ImageChoice | null>(null);
  const [pose, setPose] = useState<ImageChoice | null>(null);
  const [selectedModels, setSelectedModels] = useState<Set<PoseModelKey>>(new Set(['qwen_image_edit']));
  const [selectedProvider, setSelectedProvider] = useState<PoseProvider>('kie');
  const [selectedPlatform, setSelectedPlatform] = useState<PosePlatform | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');

  const { extract: extractPose, reset: resetPose, result: poseResult, loading: poseLoading, error: poseError } = useBlazePose();

  // Seed when dialog opens
  useEffect(() => {
    if (!open) return;
    const normalized = initialSlug?.replace(/^@/, '').trim();
    const match = normalized ? imageAssets.find((a) => a.id === normalized) : null;
    setModel(match ? mediaItemToChoice(match) : null);
    setGarment(null);
    setPose(null);
    setSelectedModels(new Set(['qwen_image_edit']));
    setSelectedProvider('kie');
    setSelectedPlatform(null);
    setCustomPrompt('');
    resetPose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Run BlazePose whenever the pose slot changes
  useEffect(() => {
    if (!open) return;
    if (!pose) {
      resetPose();
      return;
    }
    if (poseResult?.sourceAssetId === pose.assetId) return;
    extractPose(pose.assetId, pose.fullUrl);
  }, [pose, open, extractPose, resetPose, poseResult?.sourceAssetId]);

  const choices = useMemo(() => imageAssets.map(mediaItemToChoice), [imageAssets]);

  const pickSlot = useCallback((slot: SlotKind, choice: ImageChoice) => {
    if (slot === 'model') setModel(choice);
    else if (slot === 'garment') setGarment(choice);
    else setPose(choice);
  }, []);

  const toggleGenModel = useCallback((m: PoseModelKey) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  }, []);

  const canSubmit = !submitting
    && !!projectSlug
    && !!model
    && !!garment
    && !!pose
    && !!poseResult
    && !poseLoading
    && !poseError
    && selectedModels.size > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !projectSlug || !model || !garment || !pose || !poseResult) return;
    const res = await generate({
      projectSlug,
      modelImageSlug: model.assetId,
      garmentImageSlug: garment.assetId,
      poseSkeletonBlob: poseResult.skeleton.blob,
      poseSkeletonFilename: `pose-skeleton-${pose.assetId}.png`,
      models: [...selectedModels],
      provider: selectedProvider,
      platform: selectedPlatform ?? undefined,
      customPrompt: customPrompt.trim() || undefined,
    });
    if (res) onOpenChange(false);
  }, [canSubmit, projectSlug, model, garment, pose, poseResult, generate, selectedModels, selectedProvider, selectedPlatform, customPrompt, onOpenChange]);

  const jobCount = useMemo(() => selectedModels.size, [selectedModels.size]);

  const renderSlot = (slot: SlotKind, selected: ImageChoice | null, label: string) => {
    return (
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70">
            {label}
          </h3>
        </div>
        {choices.length === 0 ? (
          <div className="text-[11px] font-mono text-amber-500/50 italic px-2 py-4 rounded border border-dashed border-amber-500/20">
            No images in this project yet.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2 max-h-[120px] overflow-y-auto pr-1">
            {choices.map((c) => {
              const isSelected = selected?.assetId === c.assetId;
              return (
                <button
                  key={`${slot}-${c.assetId}`}
                  type="button"
                  onClick={() => pickSlot(slot, c)}
                  disabled={submitting}
                  title={c.slug}
                  className={cn(
                    'relative aspect-square rounded overflow-hidden border transition-all duration-150',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    isSelected
                      ? 'border-amber-400 ring-2 ring-amber-400/60'
                      : 'border-amber-500/20 hover:border-amber-400/50',
                  )}
                >
                  {c.thumbUrl ? (
                    <img src={c.thumbUrl} alt={c.slug} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-amber-500/5" />
                  )}
                  <div className={cn(
                    'absolute inset-x-0 bottom-0 px-1 py-0.5 text-[8px] font-mono truncate',
                    isSelected ? 'bg-amber-500/80 text-black' : 'bg-black/70 text-amber-200/80',
                  )}>
                    {c.slug}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(820px,94vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2',
            'rounded border border-amber-500/30 bg-black/95 backdrop-blur-sm',
            'shadow-[0_0_48px_rgba(245,158,11,0.15)] text-amber-200',
            'flex flex-col overflow-hidden',
          )}
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-amber-500/30 bg-amber-500/5">
            <Dialog.Title className="flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-widest text-amber-300">
              <Shirt className="w-3.5 h-3.5" />
              Outfit — Model + Garment + Pose
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
            {renderSlot('model', model, 'Model (Image 1)')}
            {renderSlot('garment', garment, 'Garment (Image 2)')}
            {renderSlot('pose', pose, 'Pose Reference (Image 3)')}

            {/* Skeleton preview */}
            {pose && (
              <section>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70">
                    BlazePose Skeleton
                  </h3>
                  <span className="text-[10px] font-mono text-amber-500/50">
                    {poseLoading ? 'detecting…' : poseError ? 'failed' : poseResult ? `${poseResult.keypoints.length} keypoints` : ''}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="aspect-square rounded overflow-hidden border border-amber-500/20 bg-black">
                    <img src={pose.fullUrl} alt="pose reference" className="w-full h-full object-contain" />
                  </div>
                  <div className="aspect-square rounded overflow-hidden border border-amber-500/20 bg-black flex items-center justify-center relative">
                    {poseLoading && <Loader2 className="w-5 h-5 animate-spin text-amber-400" />}
                    {poseError && (
                      <div className="flex flex-col items-center gap-1 text-[11px] font-mono text-red-300/80 text-center px-2">
                        <AlertTriangle className="w-4 h-4" />
                        {poseError}
                      </div>
                    )}
                    {poseResult && !poseLoading && !poseError && (
                      <img src={poseResult.skeleton.dataUrl} alt="skeleton" className="w-full h-full object-contain" />
                    )}
                  </div>
                </div>
              </section>
            )}

            {/* Platform aesthetic */}
            <section>
              <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70 mb-2">
                Platform Aesthetic
              </h3>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedPlatform(null)}
                  disabled={submitting}
                  className={cn(
                    'h-7 px-3 rounded border transition-colors duration-150',
                    'text-[11px] font-mono font-bold uppercase tracking-wider',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    selectedPlatform === null
                      ? 'bg-amber-500/20 border-amber-400 text-amber-100'
                      : 'bg-transparent border-amber-500/30 text-amber-300/70 hover:border-amber-400/60 hover:text-amber-200',
                  )}
                >
                  None
                </button>
                {POSE_PLATFORMS.map((p) => {
                  const isSelected = selectedPlatform === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setSelectedPlatform(p)}
                      disabled={submitting}
                      className={cn(
                        'h-7 px-3 rounded border transition-colors duration-150',
                        'text-[11px] font-mono font-bold uppercase tracking-wider',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        isSelected
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
                  const isSelected = selectedProvider === p.key;
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
                        isSelected
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

            {/* Models */}
            <section>
              <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70 mb-2">
                Image Models
              </h3>
              <div className="flex flex-wrap gap-2">
                {POSE_MODEL_OPTIONS.map((m) => {
                  const isSelected = selectedModels.has(m.key);
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => toggleGenModel(m.key)}
                      disabled={submitting}
                      className={cn(
                        'h-7 px-3 rounded border transition-colors duration-150',
                        'text-[11px] font-mono font-bold tracking-wider',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        isSelected
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

            {/* Custom Prompt */}
            <section>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400/70">
                  Additional Instruction
                </h3>
                <span className="text-[10px] font-mono text-amber-500/50 tabular-nums">
                  {customPrompt.length} / {OUTFIT_CUSTOM_PROMPT_MAX}
                </span>
              </div>
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value.slice(0, OUTFIT_CUSTOM_PROMPT_MAX))}
                disabled={submitting}
                placeholder="e.g. outdoor setting, soft evening light, keep the headscarf"
                rows={2}
                className={cn(
                  'w-full px-2 py-1.5 rounded border border-amber-500/30 bg-black/60 text-amber-200',
                  'text-[11px] font-mono placeholder:text-amber-500/40',
                  'focus:outline-none focus:border-amber-400 resize-none',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              />
            </section>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-amber-500/30 bg-amber-500/5">
            <div className="text-[11px] font-mono text-amber-300/80 tabular-nums">
              <span className="text-amber-200 font-bold">{jobCount}</span> image{jobCount === 1 ? '' : 's'} will be queued
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
