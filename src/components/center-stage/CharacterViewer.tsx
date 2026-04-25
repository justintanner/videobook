import { useCallback, useMemo, useState } from 'react';
import { Settings, X, Pencil, Shirt as OutfitIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import { useMountKey } from '@/contexts/MountKeyContext';
import { useCharacterSlots, type SlotKind, type CharacterProfile } from '@/hooks/useCharacterSlots';
import { useCharacterPin } from '@/hooks/useCharacterPin';
import { useGenerateOutfit } from '@/hooks/useGenerateOutfit';
import { CharacterProfilePanel } from '@/components/character/CharacterProfilePanel';
import { SlotRow } from '@/components/character/SlotRow';
import { AssetPickerModal } from '@/components/character/AssetPickerModal';
import { SimpleOutfitDialog } from '@/components/outfit/SimpleOutfitDialog';
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
  onSelectAsset: (assetId: string) => void;
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
  onSelectAsset,
  onEditProfile,
}: CharacterViewerProps) {
  useMountKey('character-viewer');

  const slots = useCharacterSlots(callTool, callState, item.id, projectSlug);
  const pin = useCharacterPin(callTool, projectSlug, item.id, slots.refresh);
  const { generate: generateOutfit, submitting: outfitSubmitting } = useGenerateOutfit(callTool);

  const [pickerSlot, setPickerSlot] = useState<SlotKind | null>(null);
  const [outfitOpen, setOutfitOpen] = useState(false);

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
  const outfitItems = useMemo(
    () => slots.outfits.map((id) => assetById.get(id)).filter((x): x is MediaItem => !!x),
    [slots.outfits, assetById],
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

  const handleAddOutfit = useCallback(() => {
    setOutfitOpen(true);
  }, []);

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div className="flip-card-perspective w-full h-full">
        <div className={cn('flip-card-inner w-full h-full relative', flipped && 'flipped')}>
          {/* FRONT FACE */}
          <div className="flip-card-face absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            <ViewerToolbar
              left={
                <button
                  type="button"
                  onClick={handleEditProfile}
                  disabled={!slots.profile}
                  title="Edit profile and regenerate sheet"
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono uppercase tracking-wider transition-colors',
                    slots.profile
                      ? 'text-violet-200 hover:bg-violet-500/20'
                      : 'text-zinc-600 cursor-not-allowed',
                  )}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit
                </button>
              }
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
              <aside className="w-72 shrink-0 border-r border-violet-500/20 overflow-y-auto bg-black/40">
                <CharacterProfilePanel
                  profile={slots.profile}
                  loading={slots.loading}
                  error={slots.error}
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
            </div>

            {/* Bottom: slot rows */}
            <div className="shrink-0 bg-black/50 max-h-[40%] overflow-y-auto">
              <SlotRow
                label="Wardrobe"
                items={wardrobeItems}
                emptyHint="garment"
                onAdd={() => setPickerSlot('wardrobe')}
                onSelect={onSelectAsset}
                onUnpin={(assetId) => void pin.unpin('wardrobe', assetId)}
              />
              <SlotRow
                label="Poses"
                items={poseItems}
                emptyHint="pose ref"
                onAdd={() => setPickerSlot('poses')}
                onSelect={onSelectAsset}
                onUnpin={(assetId) => void pin.unpin('poses', assetId)}
              />
              <SlotRow
                label="Outfits"
                items={outfitItems}
                emptyHint="render"
                onAdd={handleAddOutfit}
                onSelect={onSelectAsset}
                onUnpin={(assetId) => void pin.unpin('outfits', assetId)}
              />
              <div className="px-3 pb-2 pt-1">
                <button
                  type="button"
                  onClick={handleAddOutfit}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-purple-400/40 text-[10px] font-mono uppercase tracking-wider text-purple-200 hover:bg-purple-500/20 transition-colors"
                >
                  <OutfitIcon className="w-3 h-3" />
                  Compose outfit
                </button>
              </div>
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
        title={pickerSlot === 'wardrobe' ? 'Pin garment to wardrobe' : pickerSlot === 'poses' ? 'Pin pose reference' : 'Pin asset'}
        assets={pickerAssets}
        excludeIds={pickerSlot === 'wardrobe' ? slots.wardrobe : pickerSlot === 'poses' ? slots.poses : []}
        onPick={handlePick}
        onClose={() => setPickerSlot(null)}
      />

      <SimpleOutfitDialog
        open={outfitOpen}
        onOpenChange={setOutfitOpen}
        character={{ id: item.id, slug: item.slug }}
        wardrobe={wardrobeItems}
        poses={poseItems}
        projectSlug={projectSlug}
        generate={generateOutfit}
        submitting={outfitSubmitting}
        callTool={callTool}
        callState={callState}
      />
    </div>
  );
}
