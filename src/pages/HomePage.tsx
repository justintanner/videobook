import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Grid3x3 } from 'lucide-react';
import { CollapsibleSidebar } from '@/components/sidebar/CollapsibleSidebar';
import { SidebarHeader } from '@/components/sidebar/SidebarHeader';
import { UploadSlot } from '@/components/sidebar/UploadSlot';
import { ImageCard } from '@/components/sidebar/cards/ImageCard';
import { AudioCard } from '@/components/sidebar/cards/AudioCard';
import { ScriptCard } from '@/components/sidebar/cards/ScriptCard';
import { PlanCard } from '@/components/sidebar/cards/PlanCard';
import { VideoCard } from '@/components/sidebar/cards/VideoCard';
import { FinalVideoCard } from '@/components/sidebar/cards/FinalVideoCard';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { AssetMenu } from '@/components/sidebar/menus/AssetMenu';
import { IdleScreen, AssetViewer } from '@/components/center-stage';
import type { ViewerSize } from '@/components/center-stage';
import { GitHistoryPanel } from '@/components/center-stage/GitHistoryPanel';
import { ChatInput } from '@/components/ui/ChatInput';
import type { ChatInputHandle } from '@/components/ui/ChatInput';
import { HomeHeaderBar } from '@/components/layout/HomeHeaderBar';
import { InboxDrawer } from '@/components/commands';
import { TimelineSlot } from '@/components/timeline/TimelineSlot';
import { DropzoneOverlay } from '@/components/DropzoneOverlay';
import { useMcpConnection } from '@/hooks/useMcpConnection';
import { useUploadFile } from '@/hooks/useUploadFile';
import { useDefaultProject } from '@/hooks/useDefaultProject';
import { useWindowDropzone } from '@/hooks/useWindowDropzone';
import { useSync } from '@/hooks/useSync';
import { useSwitchProject } from '@/hooks/useSwitchProject';
import { useListAssets } from '@/hooks/useListAssets';
import { useTimeline } from '@/hooks/useTimeline';
import type { Orientation } from '@/hooks/useTimeline';
import { CommandRegistryProvider } from '@/contexts/CommandRegistryContext';
import { MountKeyProvider } from '@/contexts/MountKeyContext';
import type { UiActionMap } from '@/lib/ui-actions';
import type { MediaItem, AssetType, ClipState } from '@/components/sidebar/types';

const ASSET_TYPES = new Set<string>(['image', 'audio', 'script', 'plan']);
const CLIP_TYPES = new Set<string>(['video', 'final']);
const SIDEBAR_HIDDEN_STATUSES = new Set<string>(['unreviewed', 'generating', 'downloading']);
const GENERATING_STATUSES = new Set<string>(['generating', 'downloading', 'loading']);

function humanizeId(id: string): string {
  const rawName = id.replace(/^[a-z]+-/, '');
  return rawName
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function HomePage() {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [inboxOpen, setInboxOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [historyItem, setHistoryItem] = useState<MediaItem | null>(null);
  const [viewerSize, setViewerSize] = useState<ViewerSize>('landscape');
  const [viewerFlipped, setViewerFlipped] = useState(false);
  const [pendingFilePosition, setPendingFilePosition] = useState<number | null>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevInboxOpenRef = useRef(false);

  const { callTool, state } = useMcpConnection();
  const { upload } = useUploadFile(callTool);
  const { projectSlug, setProjectSlug } = useDefaultProject(callTool, state);
  const { sync, syncCount, result } = useSync(callTool);
  const { switchProject } = useSwitchProject(callTool);
  const { listAssets, assets: assetList, clearAssets } = useListAssets(callTool);
  const { timeline, fetchTimeline, setRenderOrientation, setCurrentOrientation } = useTimeline(callTool);

  // Refocus ChatInput after InboxDrawer closes
  useEffect(() => {
    if (prevInboxOpenRef.current && !inboxOpen) {
      chatInputRef.current?.focus();
    }
    prevInboxOpenRef.current = inboxOpen;
  }, [inboxOpen]);

  // Refresh assets after each sync or sort change
  useEffect(() => {
    if (!projectSlug || syncCount === 0) return;
    listAssets(projectSlug, sortOrder);
  }, [projectSlug, syncCount, sortOrder, listAssets]);

  const mediaItems = useMemo(() => {
    if (!assetList) return [] as Array<MediaItem & { created_at: string }>;
    const failedSet = new Set<string>();
    if (result) {
      for (const f of result.failed) {
        failedSet.add(f.assetId);
      }
    }

    return assetList.map((asset) => {
      let status: ClipState = (asset.status ?? 'ready') as ClipState;
      if (failedSet.has(asset.id)) status = 'error';
      return {
        id: asset.id,
        type: asset.type as AssetType,
        slug: `@${asset.id}`,
        title: humanizeId(asset.id),
        filePath: asset.media_url ?? '',
        thumbnailSrc: asset.thumbnail_url,
        status,
        created_at: asset.created_at,
        width: asset.width,
        height: asset.height,
        origin: asset.origin,
        prompt: asset.prompt,
      };
    });
  }, [assetList, result]);

  const assets = useMemo(() =>
    mediaItems.filter((m) => ASSET_TYPES.has(m.type)),
  [mediaItems]);

  const clips = useMemo(() =>
    mediaItems.filter((m) => CLIP_TYPES.has(m.type) && !SIDEBAR_HIDDEN_STATUSES.has(m.status ?? '')),
  [mediaItems]);

  const allClipItems = useMemo(() =>
    mediaItems.filter((m) => CLIP_TYPES.has(m.type)),
  [mediaItems]);

  const unreviewedClips = useMemo(() =>
    allClipItems.filter(c => c.status === 'unreviewed'),
  [allClipItems]);

  const pendingClips = useMemo(() =>
    allClipItems.filter(c => GENERATING_STATUSES.has(c.status ?? '')),
  [allClipItems]);

  const inboxState: 'inactive' | 'generating' | 'ready' =
    unreviewedClips.length > 0 ? 'ready'
    : pendingClips.length > 0 ? 'generating'
    : 'inactive';

  // Derive the active selection — clear if item was removed from list
  const activeSelection = useMemo(() => {
    if (!selectedItem) return null;
    return mediaItems.find(m => m.id === selectedItem.id) ?? null;
  }, [mediaItems, selectedItem]);

  const handleSelectItem = useCallback((item: MediaItem) => {
    setSelectedItem(item);
    const isClip = item.type === 'video' || item.type === 'final';
    setViewerSize(isClip && timeline?.currentOrientation ? timeline.currentOrientation : 'original');
  }, [timeline]);

  const handleViewerSizeChange = useCallback((size: ViewerSize) => {
    setViewerSize(size);
    if (projectSlug) setCurrentOrientation(projectSlug, size);
  }, [projectSlug, setCurrentOrientation]);

  const renderOrientation = useMemo<Orientation>(
    () => timeline?.render ?? 'landscape',
    [timeline],
  );

  const handleChangeOrientation = useCallback(async (orient: Orientation) => {
    if (!projectSlug) return;
    await setRenderOrientation(projectSlug, orient);
  }, [projectSlug, setRenderOrientation]);

  // Sync on mount + poll every 5s while page is active
  useEffect(() => {
    if (!projectSlug) return;
    sync(projectSlug);
    fetchTimeline(projectSlug).then(config => {
      if (config?.currentOrientation) setViewerSize(config.currentOrientation);
    });
    const id = setInterval(() => sync(projectSlug), 5_000);
    return () => clearInterval(id);
  }, [projectSlug, sync, fetchTimeline]);

  const triggerUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDrop = useCallback((files: File[]) => {
    if (!projectSlug) return;
    const uploads = files.map((file) => upload(projectSlug, file));
    Promise.allSettled(uploads).then(() => sync(projectSlug));
  }, [projectSlug, upload, sync]);

  const handleApprove = useCallback((video: MediaItem) => {
    if (!projectSlug) return;
    callTool('whitelist', { asset_id: video.id, project_slug: projectSlug });
  }, [callTool, projectSlug]);

  const handleReject = useCallback((video: MediaItem) => {
    if (!projectSlug) return;
    callTool('delete_asset', { asset_id: video.id, project_slug: projectSlug });
  }, [callTool, projectSlug]);

  const handleProjectChange = useCallback(async (slug: string) => {
    clearAssets();
    setProjectSlug(slug);
    await switchProject(slug);
    await listAssets(slug, sortOrder);
  }, [setProjectSlug, clearAssets, switchProject, listAssets, sortOrder]);

  const handleShowHistory = useCallback((assetId: string) => {
    const item = mediaItems.find(m => m.id === assetId);
    if (item) setHistoryItem(item);
  }, [mediaItems]);

  const handleOpenAsset = useCallback((assetId: string) => {
    const item = mediaItems.find(m => m.id === assetId);
    if (item) handleSelectItem(item);
  }, [mediaItems, handleSelectItem]);

  const handleAnimateCommand = useCallback((text: string) => {
    chatInputRef.current?.animateAndSend(text);
  }, []);

  const assetSlugs = useMemo(() => mediaItems.map((m) => m.slug), [mediaItems]);

  const { isDragging } = useWindowDropzone({ onDrop: handleDrop });

  const uiActions: UiActionMap = useMemo(() => ({
    open_upload: triggerUpload,
    open_inbox: () => setInboxOpen(true),
    copy_clipboard: (raw: string) => navigator.clipboard.writeText(raw),
    show_history: handleShowHistory,
    open_asset: handleOpenAsset,
    switch_project: handleProjectChange,
    viewer_set_original: () => handleViewerSizeChange('original'),
    viewer_set_landscape: () => handleViewerSizeChange('landscape'),
    viewer_set_portrait: () => handleViewerSizeChange('portrait'),
    viewer_toggle_info: () => setViewerFlipped(f => !f),
    viewer_focus_file: (pos: number) => {
      setViewerFlipped(true);
      setPendingFilePosition(pos);
    },
  }), [triggerUpload, handleShowHistory, handleOpenAsset, handleProjectChange, handleViewerSizeChange]);

  return (
    <MountKeyProvider>
    <CommandRegistryProvider callTool={callTool} state={state} projectSlug={projectSlug} uiActions={uiActions}>
      <div className="w-screen h-screen bg-background overflow-hidden">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
              handleDrop(Array.from(files));
            }
            e.target.value = '';
          }}
        />
        <DropzoneOverlay isDragging={isDragging} />
        <InboxDrawer
          open={inboxOpen}
          onClose={() => setInboxOpen(false)}
          videos={unreviewedClips}
          pendingVideos={pendingClips}
          onApprove={handleApprove}
          onReject={handleReject}
        />
        <div className="grid grid-rows-[48px_1fr_auto] h-full">
          <HomeHeaderBar
            pulseKey={syncCount}
            projectSlug={projectSlug}
            callTool={callTool}
            onProjectChange={handleProjectChange}
            inboxState={inboxState}
            generatingCount={pendingClips.length}
            readyCount={unreviewedClips.length}
            onInboxClick={() => setInboxOpen(true)}
          />

          <div className="flex flex-row overflow-hidden">
            {/* Left Sidebar — Assets */}
            <CollapsibleSidebar
              side="left"
              collapsed={leftCollapsed}
              onToggle={() => setLeftCollapsed(c => !c)}
              expandedWidth="240px"
              collapsedWidth="40px"
              padding="px-2 pt-2 pb-2"
              gap="gap-0"
            >
              <SidebarHeader
                icon={<Grid3x3 className="w-3.5 h-3.5" />}
                title="Assets"
                collapsed={leftCollapsed}
                onToggle={() => setLeftCollapsed(c => !c)}
                side="left"
                sortOrder={sortOrder}
                onSortChange={() => setSortOrder(s => s === 'newest' ? 'oldest' : 'newest')}
              />
              <div className="flex-1 overflow-y-auto space-y-2 pr-2">
                {assets.map((item) => {
                  const menu = (
                    <AssetMenu
                      slug={item.slug}
                      onShowFolder={() => callTool('show_folder', { asset_id: item.id, project_slug: projectSlug })}
                      onShowHistory={() => setHistoryItem(item)}
                      onAnimateCommand={handleAnimateCommand}
                      MenuItem={ContextMenuItem}
                    />
                  );
                  return (
                    <div key={item.id} className="w-full">
                      {item.type === 'image' && <ImageCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} />}
                      {item.type === 'audio' && <AudioCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} />}
                      {item.type === 'script' && <ScriptCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} />}
                      {item.type === 'plan' && <PlanCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} />}
                    </div>
                  );
                })}
                <UploadSlot onClick={triggerUpload} />
              </div>
            </CollapsibleSidebar>

            {/* Center Stage */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 p-4 overflow-hidden flex flex-col">
                {historyItem ? (
                  <GitHistoryPanel
                    item={historyItem}
                    projectSlug={projectSlug ?? ''}
                    callTool={callTool}
                    onClose={() => setHistoryItem(null)}
                  />
                ) : activeSelection ? (
                  <AssetViewer item={activeSelection} projectSlug={projectSlug ?? ''} size={viewerSize} onSizeChange={handleViewerSizeChange} flipped={viewerFlipped} onFlippedChange={setViewerFlipped} renderOrientation={renderOrientation} onChangeOrientation={handleChangeOrientation} pendingFilePosition={pendingFilePosition} onClearPendingFilePosition={() => setPendingFilePosition(null)} />
                ) : (
                  <IdleScreen label="WAITING FOR INPUT" fillParent />
                )}
              </div>
              <div className="shrink-0 px-4 pb-3 pt-2">
                <ChatInput
                  ref={chatInputRef}
                  assetSlugs={assetSlugs}
                  callTool={callTool}
                  projectSlug={projectSlug}
                />
              </div>
            </div>

            {/* Right Sidebar — Clips */}
            <CollapsibleSidebar
              side="right"
              collapsed={rightCollapsed}
              onToggle={() => setRightCollapsed(c => !c)}
              expandedWidth="240px"
              collapsedWidth="40px"
              padding="px-2 pt-2 pb-2"
              gap="gap-0"
            >
              <SidebarHeader
                icon={<Grid3x3 className="w-3.5 h-3.5" />}
                title="Clips"
                collapsed={rightCollapsed}
                onToggle={() => setRightCollapsed(c => !c)}
                side="right"
                sortOrder={sortOrder}
                onSortChange={() => setSortOrder(s => s === 'newest' ? 'oldest' : 'newest')}
              />
              <div className="flex-1 overflow-y-auto space-y-2 mt-2 pr-2">
                {clips.map((item) => {
                  const menu = (
                    <AssetMenu
                      slug={item.slug}
                      onShowFolder={() => callTool('show_folder', { asset_id: item.id, project_slug: projectSlug })}
                      onShowHistory={() => setHistoryItem(item)}
                      onAnimateCommand={handleAnimateCommand}
                      MenuItem={ContextMenuItem}
                    />
                  );
                  return (
                    <div key={item.id} className="w-full">
                      {item.type === 'video' && <VideoCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} />}
                      {item.type === 'final' && <FinalVideoCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} />}
                    </div>
                  );
                })}
                <UploadSlot onClick={triggerUpload} />
              </div>
            </CollapsibleSidebar>
          </div>

          {/* Timeline */}
          <div className="border-t border-border bg-card/30">
            <div className="relative h-28 flex gap-0.5">
              <TimelineSlot label="@s01" flex={3} />
              <TimelineSlot label="@s02" flex={2} />
              <TimelineSlot label="@s03" flex={3} />
              <TimelineSlot label="@s04" flex={2} />
              <TimelineSlot label="@s05" flex={2} />
            </div>
            <div className="relative h-12 border-t border-border/30 bg-card/20" />
          </div>
        </div>
      </div>
    </CommandRegistryProvider>
    </MountKeyProvider>
  );
}
