import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Zap, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import {
  OUTFIT_MODEL_OPTIONS,
  type OutfitModelKey,
  type UseGenerateOutfitResult,
} from '@/hooks/useGenerateOutfit';
import { usePoseExtract } from '@/hooks/usePoseExtract';
import { usePoseDescription } from '@/hooks/usePoseDescription';
import { SlotRow } from '@/components/character/SlotRow';
import type { UseMcpResult } from 'use-mcp/react';

const DEFAULT_MODELS: OutfitModelKey[] = OUTFIT_MODEL_OPTIONS.map((m) => m.key);

interface CharacterComposeRailProps {
  characterId: string;
  projectSlug: string | undefined;
  outfits: MediaItem[];
  wardrobe: MediaItem[];
  poses: MediaItem[];
  onSelectAsset: (assetId: string) => void;
  onUnpin: (slot: 'wardrobe' | 'poses' | 'outfits', assetId: string) => void;
  onAddWardrobe: () => void;
  onAddPose: () => void;
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
  onSelectAsset,
  onUnpin,
  onAddWardrobe,
  onAddPose,
  generate,
  submitting,
  callTool,
  callState,
}: CharacterComposeRailProps) {
  const [pickedGarmentId, setPickedGarmentId] = useState<string | null>(null);
  const [pickedPoseId, setPickedPoseId] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Set<OutfitModelKey>>(
    () => new Set(DEFAULT_MODELS),
  );

  // Auto-fallback to the first pinned item when the explicit pick is missing or stale.
  const garmentId = useMemo(() => {
    if (pickedGarmentId && wardrobe.some((g) => g.id === pickedGarmentId)) return pickedGarmentId;
    return wardrobe[0]?.id ?? null;
  }, [pickedGarmentId, wardrobe]);
  const poseId = useMemo(() => {
    if (pickedPoseId && poses.some((p) => p.id === pickedPoseId)) return pickedPoseId;
    return poses[0]?.id ?? null;
  }, [pickedPoseId, poses]);

  const selectedPose = useMemo(() => poses.find((p) => p.id === poseId) ?? null, [poses, poseId]);

  const {
    extract: extractPose,
    reset: resetPose,
    result: poseResult,
    loading: poseLoading,
    error: poseError,
  } = usePoseExtract(9 / 16);

  useEffect(() => {
    if (!selectedPose) {
      resetPose();
      return;
    }
    const url = selectedPose.filePath ?? selectedPose.thumbnailSrc ?? '';
    if (!url) return;
    extractPose(selectedPose.id, url);
  }, [selectedPose, extractPose, resetPose]);

  const { poseDescription, shot } = usePoseDescription({
    callTool,
    callState,
    projectSlug,
    poseSlug: poseId,
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
    !!garmentId &&
    !!selectedPose &&
    !!poseResult &&
    !poseLoading &&
    !poseError &&
    selectedModels.size > 0;

  const handleGenerate = useCallback(async () => {
    if (!canSubmit || !projectSlug || !garmentId || !selectedPose || !poseResult) return;
    await generate({
      projectSlug,
      modelImageSlug: characterId,
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
  }, [
    canSubmit,
    projectSlug,
    characterId,
    garmentId,
    selectedPose,
    poseResult,
    poseDescription,
    shot,
    selectedModels,
    generate,
  ]);

  return (
    <aside className="w-80 shrink-0 border-l border-violet-500/20 overflow-y-auto bg-black/40 flex flex-col">
      <SlotRow
        label="Outfits"
        items={outfits}
        emptyHint="generate"
        onSelect={onSelectAsset}
        onUnpin={(id) => onUnpin('outfits', id)}
      />
      <SlotRow
        label="Wardrobe"
        items={wardrobe}
        emptyHint="garment"
        selectedId={garmentId}
        onAdd={onAddWardrobe}
        onSelect={setPickedGarmentId}
        onUnpin={(id) => onUnpin('wardrobe', id)}
      />
      <SlotRow
        label="Poses"
        items={poses}
        emptyHint="pose ref"
        selectedId={poseId}
        onAdd={onAddPose}
        onSelect={setPickedPoseId}
        onUnpin={(id) => onUnpin('poses', id)}
      />

      <div className="border-t border-violet-500/20 px-3 py-2">
        <div className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70 mb-1.5">
          Models
        </div>
        <div className="flex flex-wrap gap-1">
          {OUTFIT_MODEL_OPTIONS.map((m) => {
            const active = selectedModels.has(m.key);
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => toggleModel(m.key)}
                className={cn(
                  'px-2 py-1 text-[9px] font-mono uppercase tracking-wider rounded border transition-colors',
                  active
                    ? 'border-violet-300 bg-violet-500/15 text-violet-100'
                    : 'border-violet-500/20 text-violet-300/60 hover:border-violet-400/50',
                )}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-violet-500/20 px-3 py-2 mt-auto space-y-2">
        <PoseStatus
          loading={poseLoading}
          error={poseError}
          ready={!!poseResult}
          hasPose={!!selectedPose}
        />
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canSubmit}
          className={cn(
            'w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-[11px] font-mono uppercase tracking-wider transition-colors',
            canSubmit
              ? 'bg-violet-500/25 border border-violet-300 text-violet-100 hover:bg-violet-500/40'
              : 'bg-zinc-800 border border-zinc-700 text-zinc-500 cursor-not-allowed',
          )}
        >
          {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
          {submitting ? 'Enqueuing…' : 'Generate'}
        </button>
        <div className="text-[9px] font-mono text-violet-400/60 text-center">
          {selectedModels.size} image{selectedModels.size === 1 ? '' : 's'} via Kie · 9:16
        </div>
      </div>
    </aside>
  );
}

function PoseStatus({
  loading,
  error,
  ready,
  hasPose,
}: {
  loading: boolean;
  error: string | null;
  ready: boolean;
  hasPose: boolean;
}) {
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
    return <div className="text-[9px] font-mono text-emerald-300/70">skeleton ready</div>;
  }
  return null;
}
