import { useState, useCallback, useEffect } from 'react';
import { Grid3x3 } from 'lucide-react';
import { CollapsibleSidebar } from '@/components/sidebar/CollapsibleSidebar';
import { SidebarHeader } from '@/components/sidebar/SidebarHeader';
import { UploadSlot } from '@/components/sidebar/UploadSlot';
import { IdleScreen } from '@/components/center-stage';
import { ChatInput } from '@/components/ui/ChatInput';
import { HomeHeaderBar } from '@/components/layout/HomeHeaderBar';
import { TimelineSlot } from '@/components/timeline/TimelineSlot';
import { DropzoneOverlay } from '@/components/DropzoneOverlay';
import { useMcpConnection } from '@/hooks/useMcpConnection';
import { useUploadFile } from '@/hooks/useUploadFile';
import { useDefaultProject } from '@/hooks/useDefaultProject';
import { useWindowDropzone } from '@/hooks/useWindowDropzone';
import { useSync } from '@/hooks/useSync';

export function HomePage() {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');

  const { callTool, state } = useMcpConnection();
  const { upload } = useUploadFile(callTool);
  const { projectSlug } = useDefaultProject(callTool, state);
  const { sync, syncCount } = useSync(callTool);

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

  const { isDragging } = useWindowDropzone({ onDrop: handleDrop });

  return (
    <div className="w-screen h-screen bg-background overflow-hidden">
      <DropzoneOverlay isDragging={isDragging} />
      <div className="grid grid-rows-[48px_1fr_auto] h-full">
        <HomeHeaderBar pulseKey={syncCount} />

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
