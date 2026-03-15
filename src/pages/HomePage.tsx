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
import { useRegisterCommands } from '@/hooks/useRegisterCommands';
import { useRegisterProjectCommands } from '@/hooks/useRegisterProjectCommands';
import { parseCommandArgs } from '@/lib/command-registry';
import type { RegisteredCommand } from '@/lib/command-registry';
import type { UseMcpResult } from 'use-mcp/react';
import type { MediaItem, AssetType, ClipState } from '@/components/sidebar/types';

const ASSET_TYPES = new Set<string>(['image', 'audio', 'script', 'plan']);
const CLIP_TYPES = new Set<string>(['video', 'final']);
const GENERATING_STATUSES = new Set<string>(['generating', 'downloading', 'loading', 'transcribing']);

function humanizeId(id: string): string {
  const rawName = id.replace(/^[a-z]+-/, '');
  return rawName
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function HomeCommands({
  callTool,
  projectSlug,
  state,
  triggerUpload,
  onOpenInbox,
  onShowHistory,
  onOpenAsset,
  onProjectChange,
}: {
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
  state: string;
  triggerUpload: () => void;
  onOpenInbox: () => void;
  onShowHistory: (assetId: string) => void;
  onOpenAsset: (assetId: string) => void;
  onProjectChange: (slug: string) => void;
}) {
  const cmds: RegisteredCommand[] = [
    {
      command: '/generate',
      description: 'Generate content from prompt',
      example: '/generate video of a dog on a skateboard @bg-neon',
      category: 'action',
      icon: 'Zap',
      size: 'lg',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'prompt', type: 'string', required: true, description: 'The prompt to generate from' },
        { name: 'model', type: 'string', required: false, description: 'Model to use for generation' },
      ],
      handler: async ({ raw }) => {
        if (!projectSlug) return false;
        const result = await callTool('chat', { prompt: `/generate ${raw}`.trim(), project_slug: projectSlug });
        return !result.isError;
      },
    },
    {
      command: '/trim',
      description: 'Trim video clip',
      example: '/trim @hero-intro 0:05 0:12',
      category: 'action',
      icon: 'Scissors',
      size: 'lg',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset to trim' },
        { name: 'start', type: 'string', required: false, description: 'Start timestamp' },
        { name: 'end', type: 'string', required: false, description: 'End timestamp' },
      ],
      handler: async ({ raw }) => {
        if (!projectSlug) return false;
        const result = await callTool('chat', { prompt: `/trim ${raw}`.trim(), project_slug: projectSlug });
        return !result.isError;
      },
    },
    {
      command: '/trim-audio',
      description: 'Trim audio clip',
      example: '/trim-audio @voiceover-main 0:00 0:30',
      category: 'action',
      icon: 'Scissors',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset to trim' },
        { name: 'start', type: 'string', required: false, description: 'Start timestamp' },
        { name: 'end', type: 'string', required: false, description: 'End timestamp' },
      ],
      handler: async ({ raw }) => {
        if (!projectSlug) return false;
        const result = await callTool('chat', { prompt: `/trim-audio ${raw}`.trim(), project_slug: projectSlug });
        return !result.isError;
      },
    },
    {
      command: '/final',
      description: 'Finalize and export',
      example: '/final',
      category: 'action',
      icon: 'Clapperboard',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [],
      handler: async ({ raw }) => {
        if (!projectSlug) return false;
        const result = await callTool('chat', { prompt: `/final ${raw}`.trim(), project_slug: projectSlug });
        return !result.isError;
      },
    },
    {
      command: '/download',
      description: 'Download video from URL',
      example: '/download https://youtube.com/watch?v=abc123',
      category: 'action',
      icon: 'Download',
      size: 'lg',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'url', type: 'string', required: true, description: 'Video URL (YouTube, Twitter/X, Instagram, TikTok, etc.)' },
        { name: 'start_time', type: 'string', required: false, description: "Start time (e.g. '30', '1:30', '2m20s')" },
        { name: 'end_time', type: 'string', required: false, description: "End time (e.g. '60', '2:00', '3m')" },
        { name: 'full', type: 'boolean', required: false, description: 'Download entire video (no 3-min cap)' },
      ],
      handler: async ({ raw }) => {
        const args = parseCommandArgs(raw, [
          { name: 'url', type: 'string', required: true, description: '' },
          { name: 'start_time', type: 'string', required: false, description: '' },
          { name: 'end_time', type: 'string', required: false, description: '' },
          { name: 'full', type: 'boolean', required: false, description: '' },
        ]);
        if (projectSlug) args.project_slug = projectSlug;
        const result = await callTool('download_video_file', args);
        return !result.isError;
      },
    },
    {
      command: '/upload',
      description: 'Upload a file',
      example: '/upload',
      category: 'action',
      icon: 'Upload',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [],
      handler: () => { triggerUpload(); return true; },
    },
    {
      command: '/inbox',
      description: 'View generations inbox',
      example: '/inbox',
      category: 'action',
      icon: 'Mailbox',
      size: 'default',
      variant: 'default',
      chevron: 'down',
      params: [],
      handler: () => { onOpenInbox(); return true; },
    },
    {
      command: '/copy-name',
      description: 'Copy asset name',
      example: '/copy-name @hero-intro',
      category: 'context_menu',
      icon: 'ClipboardCopy',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset whose name to copy' },
      ],
      handler: ({ raw }) => { navigator.clipboard.writeText(raw); return true; },
    },
    {
      command: '/show-folder',
      description: 'Show asset folder',
      example: '/show-folder @product-shot',
      category: 'context_menu',
      icon: 'FolderOpen',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset to open folder for' },
      ],
      handler: async ({ args }) => {
        const toolArgs: Record<string, string> = { asset_id: args.asset_id };
        if (projectSlug) toolArgs.project_slug = projectSlug;
        const result = await callTool('show_folder', toolArgs);
        return !result.isError;
      },
    },
    {
      command: '/duplicate',
      description: 'Duplicate an asset',
      example: '/duplicate @hero-intro hero-intro-v2',
      category: 'context_menu',
      icon: 'Copy',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset to duplicate' },
        { name: 'new_name', type: 'string', required: false, description: 'Optional name for the copy' },
      ],
      handler: async ({ args }) => {
        const toolArgs: Record<string, string> = { asset_id: args.asset_id };
        if (args.new_name) toolArgs.new_name = args.new_name;
        if (projectSlug) toolArgs.project_slug = projectSlug;
        const result = await callTool('duplicate_asset', toolArgs);
        return !result.isError;
      },
    },
    {
      command: '/history',
      description: 'View asset version history',
      example: '/history @hero-intro',
      category: 'context_menu',
      icon: 'History',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset to view history for' },
      ],
      handler: ({ args }) => { onShowHistory(args.asset_id); return true; },
    },
    {
      command: '/open',
      description: 'Open asset in viewer',
      example: '/open @hero-intro',
      category: 'context_menu',
      icon: 'Eye',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset to open' },
      ],
      handler: ({ args }) => { onOpenAsset(args.asset_id); return true; },
    },
    {
      command: '/delete',
      description: 'Delete an asset',
      example: '/delete @outro-clip',
      category: 'context_menu',
      icon: 'Trash2',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset to delete' },
      ],
      handler: async ({ args }) => {
        const toolArgs: Record<string, string> = { asset_id: args.asset_id };
        if (projectSlug) toolArgs.project_slug = projectSlug;
        const result = await callTool('delete_asset', toolArgs);
        return !result.isError;
      },
    },
    {
      command: '/rename',
      description: 'Rename an asset',
      example: '/rename @product-shot product-hero',
      category: 'context_menu',
      icon: 'Pencil',
      size: 'default',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset to rename' },
        { name: 'new_name', type: 'string', required: true, description: 'New name for the asset' },
      ],
      handler: async ({ args }) => {
        const toolArgs: Record<string, string> = { asset_id: args.asset_id, new_name: args.new_name };
        if (projectSlug) toolArgs.project_slug = projectSlug;
        const result = await callTool('rename_asset', toolArgs);
        return !result.isError;
      },
    },
  ];

  useRegisterCommands(cmds);
  useRegisterProjectCommands(callTool, state, onProjectChange);
  return null;
}

function PrefixCommands({
  prefix,
  callTool,
  projectSlug,
}: {
  prefix: string;
  callTool: UseMcpResult['callTool'];
  projectSlug: string;
}) {
  const cmds: RegisteredCommand[] = [];

  if (['vid', 'img'].includes(prefix)) {
    cmds.push({
      command: '/rewrite-prompt',
      description: 'Optimize a prompt',
      example: '/rewrite-prompt "make it more cinematic"',
      category: 'action',
      icon: 'Sparkles',
      size: 'sm',
      variant: 'default',
      chevron: 'right',
      params: [
        { name: 'prompt', type: 'string', required: true, description: 'The prompt to rewrite' },
      ],
      handler: async ({ raw }) => {
        const args = parseCommandArgs(raw, [
          { name: 'prompt', type: 'string', required: true, description: '' },
        ]);
        args.project_slug = projectSlug;
        const result = await callTool('rewrite_prompt', args);
        return !result.isError;
      },
    });
  }

  if (['vid', 'aud'].includes(prefix)) {
    cmds.push({
      command: '/isolate-vocals',
      description: 'Isolate vocals from audio',
      example: '/isolate-vocals @voiceover-main',
      category: 'action',
      icon: 'Mic',
      size: 'default',
      variant: 'violet',
      chevron: 'right',
      params: [
        { name: 'asset_id', type: 'string', required: true, description: 'Asset to isolate vocals from' },
      ],
      handler: async ({ raw }) => {
        const args = parseCommandArgs(raw, [
          { name: 'asset_id', type: 'string', required: true, description: '' },
        ]);
        args.project_slug = projectSlug;
        const result = await callTool('isolate_vocals', args);
        return !result.isError;
      },
    });
  }

  useRegisterCommands(cmds);
  return null;
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
  const chatInputRef = useRef<ChatInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevInboxOpenRef = useRef(false);

  const { callTool, state } = useMcpConnection();
  const { upload } = useUploadFile(callTool);
  const { projectSlug, setProjectSlug } = useDefaultProject(callTool, state);
  const { sync, syncCount, result } = useSync(callTool);
  const { switchProject } = useSwitchProject(callTool);
  const { listAssets, assets: assetList, clearAssets } = useListAssets(callTool);
  const { timeline, fetchTimeline, addOrientation } = useTimeline(callTool);

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
    mediaItems.filter((m) => CLIP_TYPES.has(m.type) && m.status !== 'unreviewed'),
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
    setViewerSize('original');
  }, []);

  const renderOrientations = useMemo<Orientation[]>(
    () => timeline?.render ?? ['landscape'],
    [timeline],
  );

  const videoAssetCount = useMemo(
    () => mediaItems.filter(m => m.type === 'video').length,
    [mediaItems],
  );

  const handleAddOrientation = useCallback(async (orient: Orientation) => {
    if (!projectSlug) return;
    const ok = await addOrientation(projectSlug, orient);
    if (!ok) return;
    // Fire-and-forget render jobs for each video asset
    const videos = mediaItems.filter(m => m.type === 'video');
    for (const v of videos) {
      callTool('render_video', { asset_id: v.id, project_slug: projectSlug, orientation: orient });
    }
    sync(projectSlug);
  }, [projectSlug, addOrientation, mediaItems, callTool, sync]);

  const selectedPrefix = activeSelection?.id?.split('-')[0] ?? null;

  // Sync on mount + poll every 5s while page is active
  useEffect(() => {
    if (!projectSlug) return;
    sync(projectSlug);
    fetchTimeline(projectSlug);
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

  const chatFallback = useCallback(async (input: string) => {
    if (!projectSlug) return false;
    const result = await callTool('chat', { prompt: input, project_slug: projectSlug });
    return !result.isError;
  }, [callTool, projectSlug]);

  return (
    <CommandRegistryProvider chatFallback={chatFallback}>
      <HomeCommands
        callTool={callTool}
        projectSlug={projectSlug}
        state={state}
        triggerUpload={triggerUpload}
        onOpenInbox={() => setInboxOpen(true)}
        onShowHistory={handleShowHistory}
        onOpenAsset={handleOpenAsset}
        onProjectChange={handleProjectChange}
      />
      {selectedPrefix && (
        <PrefixCommands
          prefix={selectedPrefix}
          callTool={callTool}
          projectSlug={projectSlug ?? ''}
        />
      )}
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
                  <AssetViewer item={activeSelection} projectSlug={projectSlug ?? ''} size={viewerSize} onSizeChange={setViewerSize} flipped={viewerFlipped} onFlippedChange={setViewerFlipped} renderOrientations={renderOrientations} videoAssetCount={videoAssetCount} onAddOrientation={handleAddOrientation} />
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
  );
}
