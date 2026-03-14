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
import { IdleScreen } from '@/components/center-stage';
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
import { useSkills } from '@/hooks/useSkills';
import { useChatDispatch } from '@/hooks/useChatDispatch';
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

export function HomePage() {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [inboxOpen, setInboxOpen] = useState(false);

  const chatInputRef = useRef<ChatInputHandle>(null);

  const { callTool, state } = useMcpConnection();
  const { upload } = useUploadFile(callTool);
  const { projectSlug, setProjectSlug } = useDefaultProject(callTool, state);
  const { sync, syncCount, result } = useSync(callTool);
  const { switchProject } = useSwitchProject(callTool);
  const { listAssets, assets: assetList, clearAssets } = useListAssets(callTool);
  const { skills, refresh: refreshSkills } = useSkills(callTool);

  // Refresh skills when MCP becomes ready
  useEffect(() => {
    if (state === 'ready') refreshSkills();
  }, [state, refreshSkills]);

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
      };
    });
  }, [assetList, result]);

  const assets = useMemo(() =>
    mediaItems.filter((m) => ASSET_TYPES.has(m.type)),
  [mediaItems]);

  const clips = useMemo(() =>
    mediaItems.filter((m) => CLIP_TYPES.has(m.type)),
  [mediaItems]);

  const readyClips = useMemo(() =>
    clips.filter(c => c.status === 'ready'),
  [clips]);

  const pendingClips = useMemo(() =>
    clips.filter(c => GENERATING_STATUSES.has(c.status ?? '')),
  [clips]);

  const inboxState: 'inactive' | 'generating' | 'ready' =
    readyClips.length > 0 ? 'ready'
    : pendingClips.length > 0 ? 'generating'
    : 'inactive';

  // Sync on mount + poll every 5s while page is active
  useEffect(() => {
    if (!projectSlug) return;
    sync(projectSlug);
    const id = setInterval(() => sync(projectSlug), 5_000);
    return () => clearInterval(id);
  }, [projectSlug, sync]);

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

  const { dispatch } = useChatDispatch(skills, {
    onOpenInbox: () => setInboxOpen(true),
    onSwitchProject: handleProjectChange,
    callTool,
    projectSlug,
  });

  const handleAnimateCommand = useCallback((text: string) => {
    chatInputRef.current?.animateAndSend(text);
  }, []);

  const assetSlugs = useMemo(() => mediaItems.map((m) => m.slug), [mediaItems]);

  const { isDragging } = useWindowDropzone({ onDrop: handleDrop });

  return (
    <div className="w-screen h-screen bg-background overflow-hidden">
      <DropzoneOverlay isDragging={isDragging} />
      <InboxDrawer
        open={inboxOpen}
        onClose={() => setInboxOpen(false)}
        videos={readyClips}
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
          readyCount={readyClips.length}
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
                    onOpenFolder={() => callTool('open_folder', { asset_id: item.id, project_slug: projectSlug })}
                    onAnimateCommand={handleAnimateCommand}
                    MenuItem={ContextMenuItem}
                  />
                );
                return (
                  <div key={item.id} className="w-full">
                    {item.type === 'image' && <ImageCard item={item} contextMenuContent={menu} />}
                    {item.type === 'audio' && <AudioCard item={item} contextMenuContent={menu} />}
                    {item.type === 'script' && <ScriptCard item={item} contextMenuContent={menu} />}
                    {item.type === 'plan' && <PlanCard item={item} contextMenuContent={menu} />}
                  </div>
                );
              })}
              <UploadSlot />
            </div>
          </CollapsibleSidebar>

          {/* Center Stage */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 p-4 overflow-hidden flex flex-col">
              <IdleScreen label="WAITING FOR INPUT" fillParent />
            </div>
            <div className="shrink-0 px-4 pb-3 pt-2">
              <ChatInput
                ref={chatInputRef}
                onSend={dispatch}
                assetSlugs={assetSlugs}
                skills={skills}
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
                    onOpenFolder={() => callTool('open_folder', { asset_id: item.id, project_slug: projectSlug })}
                    onAnimateCommand={handleAnimateCommand}
                    MenuItem={ContextMenuItem}
                  />
                );
                return (
                  <div key={item.id} className="w-full">
                    {item.type === 'video' && <VideoCard item={item} contextMenuContent={menu} />}
                    {item.type === 'final' && <FinalVideoCard item={item} contextMenuContent={menu} />}
                  </div>
                );
              })}
              <UploadSlot />
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
  );
}
