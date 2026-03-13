import { useState } from 'react';
import { Grid3x3, Upload } from 'lucide-react';
import { CommandButton } from '@/components/commands';
import { CollapsibleSidebar } from '@/components/sidebar/CollapsibleSidebar';
import { SidebarHeader } from '@/components/sidebar/SidebarHeader';
import { IdleScreen } from '@/components/center-stage';
import { ChatInput } from '@/components/ui/ChatInput';
import { HomeHeaderBar } from '@/components/layout/HomeHeaderBar';
import { TimelineSlot } from '@/components/timeline/TimelineSlot';

export function HomePage() {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');

  return (
    <div className="w-screen h-screen bg-background overflow-hidden">
      <div className="grid grid-rows-[48px_1fr_auto] h-full">
        <HomeHeaderBar />

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
            <div className="flex-1 overflow-y-auto space-y-2" />
            <div className="pt-2 mt-auto">
              <CommandButton command="/upload" icon={<Upload className="w-3.5 h-3.5" />} className="w-full" />
            </div>
          </CollapsibleSidebar>

          {/* Center Stage */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 p-4 overflow-hidden flex flex-col">
              <IdleScreen label="CLIPFIRST" fillParent />
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
            <div className="flex-1 overflow-y-auto space-y-2 mt-2" />
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
