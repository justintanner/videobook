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
import { TimelinePlayer } from '@/components/center-stage/TimelinePlayer';
import { useTimelinePreview } from '@/hooks/useTimelinePreview';
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
import { useRenderAsset } from '@/hooks/useRenderAsset';
import { useRenderSettings } from '@/hooks/useRenderSettings';
import type { Orientation } from '@/hooks/useTimeline';
import { CommandRegistryProvider } from '@/contexts/CommandRegistryContext';
import { MountKeyProvider } from '@/contexts/MountKeyContext';
import type { UiActionMap } from '@/lib/ui-actions';
import type { MediaItem, AssetType, ClipState } from '@/components/sidebar/types';
import { DEFAULT_RENDER_SETTINGS, storedToRenderSettings } from '@/components/center-stage/render-settings-types';
import type { RenderSettings } from '@/components/center-stage/render-settings-types';

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

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
  const [pendingBackTab, setPendingBackTab] = useState<'settings' | 'files' | null>(null);
  const [renderSettings, setRenderSettings] = useState<RenderSettings>(DEFAULT_RENDER_SETTINGS);
  const [timelineSlotIndex, setTimelineSlotIndex] = useState<number | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
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
  const { renderAsset } = useRenderAsset(callTool);
  const { fetchRenderSettings } = useRenderSettings(callTool);

  // Refocus ChatInput after InboxDrawer closes
  useEffect(() => {
    if (prevInboxOpenRef.current && !inboxOpen) {
      chatInputRef.current?.focus();
    }
    prevInboxOpenRef.current = inboxOpen;
  }, [inboxOpen]);

  // Global focus lock: prevent focus from leaving ChatInput on non-form clicks.
  // mousedown + preventDefault stops the browser from moving focus while still
  // allowing click handlers to fire normally.
  useEffect(() => {
    if (inboxOpen) return;

    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;

      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
          || tag === 'VIDEO' || tag === 'AUDIO') return;
      if (target.isContentEditable) return;

      // Allow Radix portaled content (dropdowns, popovers, context menus, dialogs)
      if (target.closest('[data-radix-popper-content-wrapper]')) return;
      if (target.closest('[data-radix-menu-content]')) return;
      if (target.closest('[role="dialog"]')) return;

      // Allow drag initiation on draggable elements
      if (target.closest('[draggable="true"]')) return;

      e.preventDefault();
      chatInputRef.current?.focus();
    };

    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [inboxOpen]);

  // ESC key closes history panel
  useEffect(() => {
    if (!historyItem) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !inboxOpen) setHistoryItem(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [historyItem, inboxOpen]);

  // Refresh assets after each sync or sort change
  useEffect(() => {
    if (!projectSlug || syncCount === 0) return;
    listAssets(projectSlug, sortOrder);
  }, [projectSlug, syncCount, sortOrder, listAssets]);

  // Refresh timeline after each sync
  useEffect(() => {
    if (!projectSlug || syncCount === 0) return;
    fetchTimeline(projectSlug);
  }, [projectSlug, syncCount, fetchTimeline]);

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
        renders: asset.renders ?? [],
        duration: asset.duration,
        waveform: asset.waveform,
        frameDirs: asset.frame_dirs,
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
    setHistoryItem(null);
    setSelectedItem(item);
    setTimelineSlotIndex(null);
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

  // Sync render settings from dedicated endpoint when selection or orientation changes
  const prevSettingsKeyRef = useRef<string>('');
  useEffect(() => {
    if (!activeSelection?.id || !projectSlug) return;
    const key = `${activeSelection.id}:${renderOrientation}`;
    if (key === prevSettingsKeyRef.current) return;
    prevSettingsKeyRef.current = key;
    let cancelled = false;
    fetchRenderSettings(activeSelection.id, projectSlug).then((all) => {
      if (cancelled) return;
      const stored = all?.[renderOrientation];
      setRenderSettings(stored ? storedToRenderSettings(stored) : DEFAULT_RENDER_SETTINGS);
    });
    return () => { cancelled = true; };
  }, [activeSelection?.id, projectSlug, renderOrientation, fetchRenderSettings]);

  const previewData = useTimelinePreview(timeline, mediaItems, projectSlug, renderOrientation);

  const frameRef = useRef(0);
  const rafRef = useRef(0);

  const handleFrameUpdate = useCallback((frame: number) => {
    frameRef.current = frame;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        setCurrentFrame(frameRef.current);
        rafRef.current = 0;
      });
    }
  }, []);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const handleChangeOrientation = useCallback(async (orient: Orientation) => {
    if (!projectSlug) return;
    await setRenderOrientation(projectSlug, orient);
  }, [projectSlug, setRenderOrientation]);

  const handleRender = useCallback(async (settings?: RenderSettings) => {
    if (!projectSlug || !activeSelection) return;
    const orient = viewerSize !== 'original' ? viewerSize as Orientation : undefined;
    await renderAsset(activeSelection.id, projectSlug, orient, settings);
  }, [projectSlug, activeSelection, renderAsset, viewerSize]);

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

  const handleAnimateEdit = useCallback((text: string) => {
    chatInputRef.current?.animateAndEdit(text);
  }, []);

  const handleSlotClick = useCallback((slotIndex: number) => {
    setSelectedItem(null);
    setHistoryItem(null);
    setTimelineSlotIndex(slotIndex);
  }, []);

  const handleAfterDispatch = useCallback(() => {
    if (!projectSlug) return;
    fetchTimeline(projectSlug);
  }, [projectSlug, fetchTimeline]);

  const assetSlugs = useMemo(() => mediaItems.map((m) => m.slug), [mediaItems]);

  const slotRefs = useMemo(() => {
    const slots = timeline?.slots;
    const count = Math.max(slots?.length ?? 0, 5);
    return Array.from({ length: count }, (_, i) => ({
      ref: `@s${String(i + 1).padStart(2, '0')}`,
      assetSlug: slots?.[i]?.slug || '',
    }));
  }, [timeline]);

  const { isDragging } = useWindowDropzone({ onDrop: handleDrop });

  const applySubsSetting = useCallback((field: string, value: string) => {
    setRenderSettings(prev => {
      switch (field) {
        case 'on': return { ...prev, subtitlesEnabled: true };
        case 'off': return { ...prev, subtitlesEnabled: false };
        case 'style': {
          if (value === 'impact' || value === 'highlight') return { ...prev, subtitleStyle: value };
          return prev;
        }
        case 'position': {
          const posMap: Record<string, 'top' | 'middle' | 'bottom'> = { top: 'top', mid: 'middle', middle: 'middle', bottom: 'bottom' };
          const pos = posMap[value];
          return pos ? { ...prev, subtitlePosition: pos } : prev;
        }
        case 'size': {
          const sizeMap: Record<string, 'small' | 'medium' | 'large'> = { s: 'small', m: 'medium', l: 'large', small: 'small', medium: 'medium', large: 'large' };
          const sz = sizeMap[value];
          return sz ? { ...prev, fontSize: sz } : prev;
        }
        case 'color': return { ...prev, textColor: value };
        case 'highlight': return { ...prev, highlightColor: value };
        default: return prev;
      }
    });
  }, []);

  const applyAudioSetting = useCallback((field: string, value: string) => {
    const num = Math.max(0, parseInt(value, 10) || 0);
    setRenderSettings(prev => {
      switch (field) {
        case 'volume': return { ...prev, audioVolume: Math.min(num, 100) };
        case 'fade-in': return { ...prev, audioFadeIn: num };
        case 'fade-out': return { ...prev, audioFadeOut: num };
        default: return prev;
      }
    });
  }, []);

  const applyOsgSetting = useCallback((field: string, value: string) => {
    setRenderSettings(prev => {
      if (field === 'position') {
        const posMap: Record<string, RenderSettings['osgPosition']> = {
          tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right',
          'top-left': 'top-left', 'top-right': 'top-right', 'bottom-left': 'bottom-left', 'bottom-right': 'bottom-right',
        };
        const pos = posMap[value];
        return pos ? { ...prev, osgPosition: pos } : prev;
      }
      if (field === 'clear') {
        return { ...prev, osgAssetId: null, osgAssetSrc: null };
      }
      // field starts with @ — treat as asset id
      if (field.startsWith('@')) {
        const assetId = field.slice(1);
        const item = mediaItems.find(m => m.id === assetId);
        return { ...prev, osgAssetId: assetId, osgAssetSrc: item?.filePath ?? null };
      }
      return prev;
    });
  }, [mediaItems]);

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
    viewer_toggle_info: () => { setPendingBackTab('settings'); setViewerFlipped(f => !f); },
    viewer_focus_file: (pos: number) => {
      setPendingBackTab('files');
      setViewerFlipped(true);
      setPendingFilePosition(pos);
    },
    viewer_show_settings: () => { setPendingBackTab('settings'); setViewerFlipped(true); },
    settings_landscape: () => { handleChangeOrientation('landscape'); setPendingBackTab('settings'); setViewerFlipped(true); },
    settings_portrait: () => { handleChangeOrientation('portrait'); setPendingBackTab('settings'); setViewerFlipped(true); },
    settings_square: () => { handleChangeOrientation('square'); setPendingBackTab('settings'); setViewerFlipped(true); },
    settings_subs: (field: string, value: string) => {
      applySubsSetting(field, value);
      setPendingBackTab('settings');
      setViewerFlipped(true);
    },
    settings_audio: (field: string, value: string) => {
      applyAudioSetting(field, value);
      setPendingBackTab('settings');
      setViewerFlipped(true);
    },
    settings_bg: (mode: string) => {
      if (mode === 'blur' || mode === 'black') {
        setRenderSettings(prev => ({ ...prev, backgroundMode: mode }));
      }
      setPendingBackTab('settings');
      setViewerFlipped(true);
    },
    settings_osg: (field: string, value: string) => {
      applyOsgSetting(field, value);
      setPendingBackTab('settings');
      setViewerFlipped(true);
    },
  }), [triggerUpload, handleShowHistory, handleOpenAsset, handleProjectChange, handleViewerSizeChange, handleChangeOrientation, applySubsSetting, applyAudioSetting, applyOsgSetting]);

  return (
    <MountKeyProvider>
    <CommandRegistryProvider callTool={callTool} state={state} projectSlug={projectSlug} uiActions={uiActions} onAfterDispatch={handleAfterDispatch}>
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
          assetSlugs={assetSlugs}
          callTool={callTool}
          projectSlug={projectSlug}
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
                      onAnimateEdit={handleAnimateEdit}
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
                  />
                ) : activeSelection ? (
                  <AssetViewer item={activeSelection} projectSlug={projectSlug ?? ''} size={viewerSize} onSizeChange={handleViewerSizeChange} flipped={viewerFlipped} onFlippedChange={setViewerFlipped} renderOrientation={renderOrientation} onChangeOrientation={handleChangeOrientation} onRender={handleRender} pendingFilePosition={pendingFilePosition} onClearPendingFilePosition={() => setPendingFilePosition(null)} pendingBackTab={pendingBackTab} onClearPendingBackTab={() => setPendingBackTab(null)} settings={renderSettings} onSettingsChange={setRenderSettings} />
                ) : timelineSlotIndex != null ? (
                  <TimelinePlayer
                    previewData={previewData}
                    initialSlotIndex={timelineSlotIndex}
                    onFrameUpdate={handleFrameUpdate}
                  />
                ) : (
                  <IdleScreen label="WAITING FOR INPUT" fillParent />
                )}
              </div>
              <div className="shrink-0 px-4 pb-3 pt-2">
                <ChatInput
                  ref={chatInputRef}
                  assetSlugs={assetSlugs}
                  slotRefs={slotRefs}
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
                      onAnimateEdit={handleAnimateEdit}
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
          <div className="border-t border-border bg-card/30 overflow-visible">
            <div className="relative h-28 flex gap-1 p-1 overflow-visible">
              {slotRefs.map((slotRef, i) => {
                const slotSlug = timeline?.slots?.[i]?.slug;
                const slotAsset = slotSlug ? mediaItems.find(m => m.id === slotSlug) : null;
                const orientKey = `${renderOrientation}_frames`;
                const frameUrls = slotAsset?.frameDirs?.[orientKey]
                  ?? slotAsset?.frameDirs?.['original_frames']
                  ?? undefined;
                return (
                  <TimelineSlot
                    key={slotRef.ref}
                    label={slotRef.ref}
                    isActive={timelineSlotIndex === i}
                    hasContent={!!slotSlug}
                    frameUrls={frameUrls}
                    waveform={slotAsset?.waveform ?? undefined}
                    duration={slotAsset?.duration ?? undefined}
                    assetId={slotSlug ? `@${slotSlug}` : undefined}
                    onClick={() => slotSlug && handleSlotClick(i)}
                    onAnimateCommand={handleAnimateCommand}
                  />
                );
              })}
            </div>
            <div className="relative h-12 border-t border-border/30 bg-card/20 flex items-center px-3 gap-3">
              {timelineSlotIndex != null && previewData.ready && (
                <>
                  {/* Progress bar with slot boundaries */}
                  <div className="flex-1 relative h-2 bg-white/5 rounded-full overflow-hidden">
                    {/* Slot boundary markers */}
                    {previewData.slotOffsets.slice(1).map((offset, i) => (
                      <div
                        key={i}
                        className="absolute top-0 bottom-0 w-px bg-white/20"
                        style={{ left: `${(offset / previewData.totalDurationInFrames) * 100}%` }}
                      />
                    ))}
                    {/* Progress fill */}
                    <div
                      className="absolute top-0 left-0 bottom-0 bg-primary/60 rounded-full transition-[width] duration-75"
                      style={{ width: `${(currentFrame / previewData.totalDurationInFrames) * 100}%` }}
                    />
                  </div>
                  {/* Time readout */}
                  <span className="text-[10px] font-mono text-muted-foreground/50 tabular-nums whitespace-nowrap">
                    {formatTime(currentFrame / previewData.fps)} / {formatTime(previewData.totalDurationInFrames / previewData.fps)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </CommandRegistryProvider>
    </MountKeyProvider>
  );
}
