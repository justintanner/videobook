import { useCallback, useMemo, useState } from 'react';
import { Settings, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import { useMountKey } from '@/contexts/MountKeyContext';
import { useCharacterSlots, type SlotKind, type CharacterProfile } from '@/hooks/useCharacterSlots';
import { useCharacterPin } from '@/hooks/useCharacterPin';
import { useGenerateOutfit } from '@/hooks/useGenerateOutfit';
import { CharacterProfilePanel } from '@/components/character/CharacterProfilePanel';
import { CharacterComposeRail } from '@/components/character/CharacterComposeRail';
import { AssetPickerModal } from '@/components/character/AssetPickerModal';
import type { UseMcpResult } from 'use-mcp/react';
import type { BackTab } from './viewer-types';
import {
  ViewerToolbar,
  BackFaceTabBar,
  FilesBackPane,
  HistoryBackPane,
  useViewerBackFace,
} from './viewer-shared';

const CHARACTER_BACK_TABS: BackTab[] = ['files', 'history'];

export interface CharacterViewerProps {
  item: MediaItem;
  projectSlug: string;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
  pendingFilePosition?: number | null;
  onClearPendingFilePosition?: () => void;
  pendingBackTab?: BackTab | null;
  onClearPendingBackTab?: () => void;
  callTool: UseMcpResult['callTool'];
  callState: UseMcpResult['state'];
  onClose: () => void;
  imageAssets: MediaItem[];
  onEditProfile: (charAssetId: string, profile: CharacterProfile) => void;
}

export function CharacterViewer({
  item,
  projectSlug,
  flipped,
  onFlippedChange,
  pendingFilePosition,
  onClearPendingFilePosition,
  pendingBackTab,
  onClearPendingBackTab,
  callTool,
  callState,
  onClose,
  imageAssets,
  onEditProfile,
}: CharacterViewerProps) {
  useMountKey('character-viewer');

  const slots = useCharacterSlots(callTool, callState, item.id, projectSlug);
  const pin = useCharacterPin(callTool, projectSlug, item.id, slots.refresh);
  const { generate: generateOutfit, submitting: outfitSubmitting } = useGenerateOutfit(callTool);

  const [pickerSlot, setPickerSlot] = useState<SlotKind | null>(null);

  const bf = useViewerBackFace({
    projectSlug,
    itemId: item.id,
    callTool,
    flipped,
    onFlippedChange,
    pendingFilePosition,
    onClearPendingFilePosition,
    pendingBackTab,
    onClearPendingBackTab,
    defaultBackTab: 'files',
  });

  const assetById = useMemo(() => {
    const m = new Map<string, MediaItem>();
    for (const a of imageAssets) m.set(a.id, a);
    return m;
  }, [imageAssets]);

  const wardrobeItems = useMemo(
    () => slots.wardrobe.map((id) => assetById.get(id)).filter((x): x is MediaItem => !!x),
    [slots.wardrobe, assetById],
  );
  const poseItems = useMemo(
    () => slots.poses.map((id) => assetById.get(id)).filter((x): x is MediaItem => !!x),
    [slots.poses, assetById],
  );
  const backdropItems = useMemo(
    () => slots.backdrop.map((id) => assetById.get(id)).filter((x): x is MediaItem => !!x),
    [slots.backdrop, assetById],
  );

  const pickerAssets = useMemo(() => {
    // For wardrobe/poses we only pick from img-* assets (not other char-*'s).
    return imageAssets.filter((a) => a.type === 'image');
  }, [imageAssets]);

  const handlePick = useCallback(
    async (assetId: string) => {
      if (!pickerSlot) return;
      const ok = await pin.pin(pickerSlot, assetId);
      if (ok) setPickerSlot(null);
    },
    [pickerSlot, pin],
  );

  const handleEditProfile = useCallback(() => {
    if (!slots.profile) return;
    onEditProfile(item.id, slots.profile);
  }, [slots.profile, onEditProfile, item.id]);

  const handleUnpin = useCallback(
    (slot: SlotKind, assetId: string) => {
      void pin.unpin(slot, assetId);
    },
    [pin],
  );

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div className="flip-card-perspective w-full h-full">
        <div className={cn('flip-card-inner w-full h-full relative', flipped && 'flipped')}>
          {/* FRONT FACE */}
          <div className="flip-card-face absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            <ViewerToolbar
              left={null}
              slug={item.slug}
              right={
                <div className="flex items-center gap-1">
                  <button
                    tabIndex={-1}
                    onClick={bf.handleFlipToBack}
                    title="/files"
                    className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
                  >
                    <Settings className="w-4 h-4 stroke-[2.5]" />
                  </button>
                  <button
                    tabIndex={-1}
                    onClick={onClose}
                    title="Close"
                    className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
                  >
                    <X className="w-4 h-4 stroke-[2.5]" />
                  </button>
                </div>
              }
            />

            {/* Top: profile panel + sheet image */}
            <div className="flex-1 min-h-0 flex bg-black/30 overflow-hidden">
              <aside className="w-60 shrink-0 border-r border-violet-500/20 overflow-y-auto bg-black/40">
                <CharacterProfilePanel
                  profile={slots.profile}
                  loading={slots.loading}
                  error={slots.error}
                  onEdit={handleEditProfile}
                />
              </aside>
              <div className="flex-1 min-w-0 flex items-center justify-center p-4">
                {item.filePath ? (
                  <img
                    src={item.filePath}
                    alt={item.title}
                    className="max-w-full max-h-full object-contain"
                    draggable={false}
                  />
                ) : (
                  <div className="text-violet-300/50 text-xs font-mono">No sheet image yet</div>
                )}
              </div>
              <CharacterComposeRail
                characterId={item.id}
                projectSlug={projectSlug}
                wardrobe={wardrobeItems}
                poses={poseItems}
                backdrop={backdropItems}
                onUnpin={handleUnpin}
                onPickWardrobe={() => setPickerSlot('wardrobe')}
                onPickPose={() => setPickerSlot('poses')}
                onPickBackdrop={() => setPickerSlot('backdrop')}
                generate={generateOutfit}
                submitting={outfitSubmitting}
                callTool={callTool}
                callState={callState}
              />
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            <BackFaceTabBar
              tabs={CHARACTER_BACK_TABS}
              active={bf.backTab}
              onSelect={bf.setBackTab}
              slug={item.slug}
              onClose={() => onFlippedChange(false)}
              onCloseViewer={onClose}
            />

            {bf.backTab === 'files' ? (
              <FilesBackPane
                manifest={bf.manifest}
                manifestLoading={bf.manifestLoading}
                selectedFile={bf.selectedFile}
                fileContent={bf.fileContent}
                fileLoading={bf.fileLoading}
                fileUrl={bf.fileUrl}
                handleSelectFile={bf.handleSelectFile}
                handleFileKeyDown={bf.handleFileKeyDown}
                fetchManifest={bf.fetchManifest}
                fetchFileContent={bf.fetchFileContent}
              />
            ) : (
              <HistoryBackPane
                commits={bf.commits}
                historyLoading={bf.historyLoading}
                selectedCommitHash={bf.selectedCommitHash}
                setSelectedCommitHash={bf.setSelectedCommitHash}
                handleRestore={bf.handleRestore}
                fetchHistory={bf.fetchHistory}
                itemId={item.id}
                projectSlug={projectSlug}
              />
            )}
          </div>
        </div>
      </div>

      <AssetPickerModal
        open={pickerSlot !== null}
        title={
          pickerSlot === 'wardrobe'
            ? 'Pin garment to wardrobe'
            : pickerSlot === 'poses'
            ? 'Pin pose reference'
            : pickerSlot === 'backdrop'
            ? 'Pin backdrop reference'
            : 'Pin asset'
        }
        assets={pickerAssets}
        excludeIds={
          pickerSlot === 'wardrobe'
            ? slots.wardrobe
            : pickerSlot === 'poses'
            ? slots.poses
            : pickerSlot === 'backdrop'
            ? slots.backdrop
            : []
        }
        onPick={handlePick}
        onClose={() => setPickerSlot(null)}
      />
    </div>
  );
}
