import { useState, useCallback, useEffect, useMemo } from 'react';
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
import { IdleScreen } from '@/components/center-stage';
import { LoadingScreen } from '@/components/LoadingScreen';
import { ChatInput } from '@/components/ui/ChatInput';
import { HomeHeaderBar } from '@/components/layout/HomeHeaderBar';
import { TimelineSlot } from '@/components/timeline/TimelineSlot';
import { DropzoneOverlay } from '@/components/DropzoneOverlay';
import { useMcpConnection } from '@/hooks/useMcpConnection';
import { useUploadFile } from '@/hooks/useUploadFile';
import { useDefaultProject } from '@/hooks/useDefaultProject';
import { useWindowDropzone } from '@/hooks/useWindowDropzone';
import { useSync } from '@/hooks/useSync';
import { useSwitchProject } from '@/hooks/useSwitchProject';
import type { MediaItem, AssetType, ClipState } from '@/components/sidebar/types';

const TASK_TYPE_TO_STATE: Record<string, ClipState> = {
  generate: 'generating',
  render: 'rendering',
  download: 'downloading',
  transcribe: 'transcribing',
};

const ASSET_TYPES = new Set<string>(['image', 'audio', 'script', 'plan']);
const CLIP_TYPES = new Set<string>(['video', 'final']);

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
  const [switching, setSwitching] = useState(false);

  const { callTool, state } = useMcpConnection();
  const { upload } = useUploadFile(callTool);
  const { projectSlug, setProjectSlug, error } = useDefaultProject(callTool, state);
  const { sync, syncCount, result, setSyncResult } = useSync(callTool);
  const { switchProject } = useSwitchProject(callTool);

  const mediaItems = useMemo(() => {
    if (!result?.assets) return [] as Array<MediaItem & { created_at: string }>;
    const pendingMap = new Map<string, ClipState>();
    const failedSet = new Set<string>();
    for (const p of result.pending) {
      pendingMap.set(p.assetId, TASK_TYPE_TO_STATE[p.taskType] ?? 'loading');
    }
    for (const f of result.failed) {
      failedSet.add(f.assetId);
    }

    return result.assets.map((asset) => {
      let status: ClipState = 'ready';
      if (pendingMap.has(asset.id)) {
        status = pendingMap.get(asset.id)!;
      } else if (failedSet.has(asset.id)) {
        status = 'error';
      }
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
  }, [result]);

  const assets = useMemo(() => {
    const items = mediaItems.filter((m) => ASSET_TYPES.has(m.type));
    const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return sortOrder === 'newest' ? sorted.reverse() : sorted;
  }, [mediaItems, sortOrder]);

  const clips = useMemo(() => {
    const items = mediaItems.filter((m) => CLIP_TYPES.has(m.type));
    const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return sortOrder === 'newest' ? sorted.reverse() : sorted;
  }, [mediaItems, sortOrder]);

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

  const handleProjectChange = useCallback(async (slug: string) => {
    setSwitching(true);
    setSyncResult(undefined);
    setProjectSlug(slug);
    try {
      const result = await switchProject(slug);
      if (result) setSyncResult(result);
    } finally {
      setSwitching(false);
    }
  }, [setProjectSlug, setSyncResult, switchProject]);

  const { isDragging } = useWindowDropzone({ onDrop: handleDrop });

  const isLoading = state !== 'ready' || (!projectSlug && !error) || switching;

  if (isLoading) {
    return <LoadingScreen label={switching ? 'SWITCHING PROJECT' : 'INITIALIZING'} />;
  }

  return (
    <div className="w-screen h-screen bg-background overflow-hidden">
      <DropzoneOverlay isDragging={isDragging} />
      <div className="grid grid-rows-[48px_1fr_auto] h-full">
        <HomeHeaderBar
          pulseKey={syncCount}
          projectSlug={projectSlug}
          callTool={callTool}
          onProjectChange={handleProjectChange}
        />

        <div className="flex flex-row overflow-hidden">
          {/* Left Sidebar — Assets */}
          <CollapsibleSidebar
            side="left"
            collapsed={leftCollapsed}
            onToggle={() => setLeftCollapsed(c => !c)}
            expandedWidth="210px"
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
            <div className="flex-1 overflow-y-auto space-y-2">
              {assets.map((item) => (
                <div key={item.id} className="w-full">
                  {item.type === 'image' && <ImageCard item={item} />}
                  {item.type === 'audio' && <AudioCard item={item} />}
                  {item.type === 'script' && <ScriptCard item={item} />}
                  {item.type === 'plan' && <PlanCard item={item} />}
                </div>
              ))}
              <UploadSlot />
            </div>
          </CollapsibleSidebar>

          {/* Center Stage */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 p-4 overflow-hidden flex flex-col">
              <IdleScreen label="WAITING FOR INPUT" fillParent />
            </div>
            <div className="shrink-0 px-4 pb-3 pt-2">
              <ChatInput assetSlugs={[]} />
            </div>
          </div>

          {/* Right Sidebar — Clips */}
          <CollapsibleSidebar
            side="right"
            collapsed={rightCollapsed}
            onToggle={() => setRightCollapsed(c => !c)}
            expandedWidth="210px"
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
            <div className="flex-1 overflow-y-auto space-y-2 mt-2">
              {clips.map((item) => (
                <div key={item.id} className="w-full">
                  {item.type === 'video' && <VideoCard item={item} />}
                  {item.type === 'final' && <FinalVideoCard item={item} />}
                </div>
              ))}
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
