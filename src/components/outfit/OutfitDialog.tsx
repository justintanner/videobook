import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shirt, Loader2, Zap, X, AlertTriangle, User, Shirt as GarmentIcon, Move } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import {
  OUTFIT_CUSTOM_PROMPT_MAX,
  OUTFIT_MODEL_OPTIONS,
  OUTFIT_PLATFORMS,
  OUTFIT_PROVIDERS,
  type OutfitModelKey,
  type OutfitPlatform,
  type OutfitProvider,
  type UseGenerateOutfitResult,
} from '@/hooks/useGenerateOutfit';
import { usePoseExtract } from '@/hooks/usePoseExtract';
import { ChatInput } from '@/components/ui/ChatInput';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { CommandDescriptor } from '@/lib/command-registry';
import type { UseMcpResult } from 'use-mcp/react';

const PLATFORM_LABELS: Record<OutfitPlatform, string> = {
  ig: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

const OUTFIT_COMMANDS: CommandDescriptor[] = [
  {
    command: '/generate', description: 'Queue outfit jobs', example: '/generate',
    category: 'action', icon: 'Zap', size: 'sm', variant: 'violet', chevron: 'right', params: [],
  },
  {
    command: '/close', description: 'Close outfit view', example: '/close',
    category: 'action', icon: 'X', size: 'sm', variant: 'default', chevron: 'right', params: [],
  },
];

type SlotKind = 'model' | 'garment' | 'pose';

const SLOT_ORDER: SlotKind[] = ['model', 'garment', 'pose'];
const SLOT_LABELS: Record<SlotKind, string> = { model: 'Model', garment: 'Garment', pose: 'Pose' };
const SLOT_BADGES: Record<SlotKind, string> = { model: 'M', garment: 'G', pose: 'P' };
const SLOT_ICONS: Record<SlotKind, typeof User> = { model: User, garment: GarmentIcon, pose: Move };

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
  callTool: UseMcpResult['callTool'];
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
  callTool,
}: OutfitDialogProps) {
  const [model, setModel] = useState<ImageChoice | null>(null);
  const [garment, setGarment] = useState<ImageChoice | null>(null);
  const [pose, setPose] = useState<ImageChoice | null>(null);
  const [activeSlot, setActiveSlot] = useState<SlotKind>('model');
  const [selectedModels, setSelectedModels] = useState<Set<OutfitModelKey>>(new Set(['qwen_image_edit']));
  const [selectedProvider, setSelectedProvider] = useState<OutfitProvider>('kie');
  const [selectedPlatform, setSelectedPlatform] = useState<OutfitPlatform | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [visible, setVisible] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  const { extract: extractPose, reset: resetPose, result: poseResult, loading: poseLoading, error: poseError } = usePoseExtract();
  const { dispatch: contextDispatch } = useCommandDispatch();

  // Seed when dialog opens
  useEffect(() => {
    if (!open) return;
    const normalized = initialSlug?.replace(/^@/, '').trim();
    const match = normalized ? imageAssets.find((a) => a.id === normalized) : null;
    setModel(match ? mediaItemToChoice(match) : null);
    setGarment(null);
    setPose(null);
    setActiveSlot(match ? 'garment' : 'model');
    setSelectedModels(new Set(['qwen_image_edit']));
    setSelectedProvider('kie');
    setSelectedPlatform(null);
    setCustomPrompt('');
    resetPose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Two-phase open: mount then animate in
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => setVisible(true), 0);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [open]);

  // Run MediaPipe Holistic whenever the pose slot changes
  useEffect(() => {
    if (!open) return;
    if (!pose) {
      resetPose();
      return;
    }
    if (poseResult?.sourceAssetId === pose.assetId) return;
    extractPose(pose.assetId, pose.fullUrl);
  }, [pose, open, extractPose, resetPose, poseResult?.sourceAssetId]);

  // Escape key → close (respecting ChatInput's preventDefault for autocomplete dismissal)
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onOpenChange(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange]);

  const choices = useMemo(() => imageAssets.map(mediaItemToChoice), [imageAssets]);
  const assetSlugs = useMemo(() => imageAssets.map((a) => a.slug), [imageAssets]);

  const slotValues: Record<SlotKind, ImageChoice | null> = { model, garment, pose };
  const slotSetters: Record<SlotKind, (c: ImageChoice | null) => void> = {
    model: setModel,
    garment: setGarment,
    pose: setPose,
  };

  const assignToActive = useCallback((choice: ImageChoice) => {
    slotSetters[activeSlot](choice);
    // advance to next empty slot (if any)
    const startIdx = SLOT_ORDER.indexOf(activeSlot);
    for (let i = 1; i <= SLOT_ORDER.length; i++) {
      const next = SLOT_ORDER[(startIdx + i) % SLOT_ORDER.length];
      if (next === activeSlot) continue;
      if (!slotValues[next]) {
        setActiveSlot(next);
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlot, model, garment, pose]);

  const badgesForAsset = useCallback((assetId: string): SlotKind[] => {
    const out: SlotKind[] = [];
    if (model?.assetId === assetId) out.push('model');
    if (garment?.assetId === assetId) out.push('garment');
    if (pose?.assetId === assetId) out.push('pose');
    return out;
  }, [model, garment, pose]);

  const toggleGenModel = useCallback((m: OutfitModelKey) => {
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

  const handleSubmit = useCallback(async (): Promise<boolean> => {
    if (!canSubmit || !projectSlug || !model || !garment || !pose || !poseResult) return false;
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
    if (res) {
      onOpenChange(false);
      return true;
    }
    return false;
  }, [canSubmit, projectSlug, model, garment, pose, poseResult, generate, selectedModels, selectedProvider, selectedPlatform, customPrompt, onOpenChange]);

  const handleOutfitSend = useCallback(async (message: string): Promise<boolean> => {
    const trimmed = message.trim();
    if (trimmed === '/close') {
      onOpenChange(false);
      return true;
    }
    if (trimmed === '/generate') {
      if (!canSubmit) return false;
      return handleSubmit();
    }
    return contextDispatch(message);
  }, [onOpenChange, canSubmit, handleSubmit, contextDispatch]);

  const jobCount = useMemo(() => selectedModels.size, [selectedModels.size]);

  const renderSlotChip = (slot: SlotKind) => {
    const choice = slotValues[slot];
    const isActive = activeSlot === slot;
    const Icon = SLOT_ICONS[slot];
    const isPose = slot === 'pose';
    return (
      <button
        key={slot}
        type="button"
        onClick={() => setActiveSlot(slot)}
        className={cn(
          'relative flex items-stretch gap-2 h-24 rounded border transition-all duration-150 overflow-hidden text-left',
          isActive
            ? 'border-purple-400 ring-2 ring-purple-400/60 bg-purple-500/5'
            : 'border-purple-500/20 hover:border-purple-400/50',
          choice ? '' : 'border-dashed',
        )}
      >
        {/* Label column */}
        <div className={cn(
          'flex flex-col justify-between py-1.5 px-2 shrink-0 w-[72px]',
          isActive ? 'bg-purple-500/20' : 'bg-purple-500/5',
        )}>
          <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-purple-200">
            <Icon className="w-3 h-3" />
            {SLOT_LABELS[slot]}
          </div>
          <span className="text-[9px] font-mono text-purple-400/60 uppercase tracking-wider">
            {isActive ? 'active' : 'tap'}
          </span>
        </div>

        {/* Preview — pose shows image + skeleton side-by-side */}
        {choice ? (
          <>
            <div className="relative w-24 h-full shrink-0 bg-black">
              <img src={choice.thumbUrl} alt={choice.slug} className="w-full h-full object-cover" />
            </div>
            {isPose && (
              <div className="relative w-24 h-full shrink-0 bg-black flex items-center justify-center">
                {poseLoading && <Loader2 className="w-4 h-4 animate-spin text-purple-400" />}
                {poseError && (
                  <div className="flex flex-col items-center gap-0.5 text-[9px] font-mono text-red-300/80 text-center px-1">
                    <AlertTriangle className="w-3 h-3" />
                    failed
                  </div>
                )}
                {poseResult && !poseLoading && !poseError && (
                  <img src={poseResult.skeleton.dataUrl} alt="skeleton" className="w-full h-full object-contain" />
                )}
              </div>
            )}
            <div className="flex-1 min-w-0 flex flex-col justify-between py-1.5 pr-2 pl-1">
              <span className="text-[10px] font-mono text-purple-100 truncate" title={choice.slug}>
                {choice.slug}
              </span>
              {isPose && poseResult && (
                <span className="text-[9px] font-mono text-purple-400/60">
                  {poseResult.landmarkCount} pts
                </span>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  slotSetters[slot](null);
                  setActiveSlot(slot);
                }}
                className="self-start text-[9px] font-mono uppercase tracking-wider text-purple-400/60 hover:text-purple-200"
              >
                clear
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[10px] font-mono text-purple-400/40 italic px-2">
            click a thumbnail
          </div>
        )}
      </button>
    );
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0',
        )}
        onClick={() => onOpenChange(false)}
      />

      {/* Full-screen shell */}
      <div
        ref={shellRef}
        role="dialog"
        aria-label="Outfit generation"
        className={cn(
          'fixed inset-0 z-[101] bg-zinc-950 flex flex-col transition-all duration-300',
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-purple-400/80 uppercase">
            <Shirt className="w-3.5 h-3.5" />
            Outfit — Model + Garment + Pose
          </div>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onOpenChange(false)}
            aria-label="Close outfit view"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* Slot targets row */}
          <section className="flex flex-wrap gap-2">
            {SLOT_ORDER.map((slot) => renderSlotChip(slot))}
          </section>

          {/* Single shared carousel */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-purple-400/70">
                Assets → {SLOT_LABELS[activeSlot]}
              </h3>
              <span className="text-[10px] font-mono text-purple-500/50">
                {choices.length} image{choices.length === 1 ? '' : 's'}
              </span>
            </div>
            {choices.length === 0 ? (
              <div className="text-[11px] font-mono text-purple-500/50 italic px-2 py-4 rounded border border-dashed border-purple-500/20">
                No images in this project yet.
              </div>
            ) : (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {choices.map((c) => {
                  const badges = badgesForAsset(c.assetId);
                  const inActive = slotValues[activeSlot]?.assetId === c.assetId;
                  return (
                    <button
                      key={c.assetId}
                      type="button"
                      onClick={() => assignToActive(c)}
                      disabled={submitting}
                      title={c.slug}
                      className={cn(
                        'relative w-28 h-28 shrink-0 rounded overflow-hidden border transition-all duration-150',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        inActive
                          ? 'border-purple-400 ring-2 ring-purple-400/60'
                          : badges.length > 0
                            ? 'border-purple-500/50 hover:border-purple-400/70'
                            : 'border-purple-500/20 hover:border-purple-400/50',
                      )}
                    >
                      {c.thumbUrl ? (
                        <img src={c.thumbUrl} alt={c.slug} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-purple-500/5" />
                      )}
                      {/* Slot badges */}
                      {badges.length > 0 && (
                        <div className="absolute top-1 left-1 flex gap-0.5">
                          {badges.map((b) => (
                            <span
                              key={b}
                              className="w-4 h-4 rounded-sm bg-purple-500/90 text-black text-[9px] font-mono font-bold flex items-center justify-center"
                              title={SLOT_LABELS[b]}
                            >
                              {SLOT_BADGES[b]}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className={cn(
                        'absolute inset-x-0 bottom-0 px-1 py-0.5 text-[8px] font-mono truncate',
                        inActive ? 'bg-purple-500/80 text-black' : 'bg-black/70 text-purple-200/80',
                      )}>
                        {c.slug}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Platform aesthetic */}
          <section>
            <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-purple-400/70 mb-2">
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
                    ? 'bg-purple-500/20 border-purple-400 text-purple-100'
                    : 'bg-transparent border-purple-500/30 text-purple-300/70 hover:border-purple-400/60 hover:text-purple-200',
                )}
              >
                None
              </button>
              {OUTFIT_PLATFORMS.map((p) => {
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
                        ? 'bg-purple-500/20 border-purple-400 text-purple-100'
                        : 'bg-transparent border-purple-500/30 text-purple-300/70 hover:border-purple-400/60 hover:text-purple-200',
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
            <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-purple-400/70 mb-2">
              Provider
            </h3>
            <div className="flex flex-wrap gap-2">
              {OUTFIT_PROVIDERS.map((p) => {
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
                        ? 'bg-purple-500/20 border-purple-400 text-purple-100'
                        : 'bg-transparent border-purple-500/30 text-purple-300/70 hover:border-purple-400/60 hover:text-purple-200',
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
            <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-purple-400/70 mb-2">
              Image Models
            </h3>
            <div className="flex flex-wrap gap-2">
              {OUTFIT_MODEL_OPTIONS.map((m) => {
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
                        ? 'bg-purple-500/20 border-purple-400 text-purple-100'
                        : 'bg-transparent border-purple-500/30 text-purple-300/70 hover:border-purple-400/60 hover:text-purple-200',
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
              <h3 className="text-[10px] font-mono font-bold uppercase tracking-wider text-purple-400/70">
                Additional Instruction
              </h3>
              <span className="text-[10px] font-mono text-purple-500/50 tabular-nums">
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
                'w-full px-2 py-1.5 rounded border border-purple-500/30 bg-black/60 text-purple-200',
                'text-[11px] font-mono placeholder:text-purple-500/40',
                'focus:outline-none focus:border-purple-400 resize-none',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            />
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-border/50 shrink-0">
          <div className="text-[11px] font-mono text-purple-300/80 tabular-nums">
            <span className="text-purple-200 font-bold">{jobCount}</span> image{jobCount === 1 ? '' : 's'} will be queued
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className={cn(
                'h-7 px-3 rounded border border-purple-500/30 text-purple-300/80',
                'text-[11px] font-mono font-bold uppercase tracking-wider',
                'hover:bg-purple-500/10 hover:text-purple-200',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={cn(
                'h-7 px-3 flex items-center gap-1.5 rounded',
                'text-[11px] font-mono font-bold uppercase tracking-wider',
                'text-purple-100 bg-purple-500/25 border border-purple-400/70 hover:bg-purple-500/40 hover:border-purple-300',
                'transition-colors duration-150',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-purple-500/25',
              )}
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Generate
            </button>
          </div>
        </div>

        {/* ChatInput bar */}
        <div className="shrink-0 border-t border-border/50 px-6 py-3">
          <ChatInput
            assetSlugs={assetSlugs}
            commands={OUTFIT_COMMANDS}
            onSend={handleOutfitSend}
            callTool={callTool}
            projectSlug={projectSlug}
            placeholder="type /generate, /close..."
          />
        </div>
      </div>
    </>
  );
}
