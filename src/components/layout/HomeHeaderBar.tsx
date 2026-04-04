import { useState, useCallback } from 'react';
import { Clapperboard, Film, ImageIcon, Settings, History } from 'lucide-react';
import { CommandButton, InboxButton } from '@/components/commands';
import { ActivityPanel } from '@/components/commands/ActivityPanel';
import { ProjectDropdown } from './ProjectDropdown';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { useProjectActivity } from '@/hooks/useProjectActivity';
import type { UseMcpResult } from 'use-mcp/react';
import type { SyncResult } from '@/hooks/useSync';

interface HomeHeaderBarProps {
  pulseKey: number;
  projectSlug: string | undefined;
  callTool: UseMcpResult['callTool'];
  onProjectChange: (slug: string) => void;
  inboxState: 'inactive' | 'generating' | 'ready';
  generatingCount: number;
  readyCount: number;
  onInboxClick: () => void;
  onAnimateCommand: (text: string) => void;
  syncResult: SyncResult | undefined;
}

export function HomeHeaderBar({ pulseKey, projectSlug, callTool, onProjectChange, inboxState, generatingCount, readyCount, onInboxClick, onAnimateCommand, syncResult }: HomeHeaderBarProps) {
  const { entries, loading, fetch } = useProjectActivity(callTool);
  const [activityOpen, setActivityOpen] = useState(false);

  const handleActivityOpen = useCallback((open: boolean) => {
    setActivityOpen(open);
    if (open && projectSlug) {
      fetch(projectSlug);
    }
  }, [projectSlug, fetch]);

  const hasFailures = (syncResult?.failed?.length ?? 0) > 0;

  return (
    <div className="bg-card border-b border-border flex items-center justify-between px-2 h-12">
      <div className="flex items-center gap-1">
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 h-full">
          <div key={pulseKey} className="w-2.5 h-2.5 rounded-full bg-primary shrink-0 logo-dot-pulse" />
          <span className="font-mono font-bold text-sm uppercase tracking-wider">
            <span className="text-foreground">CLIP</span>
            <span className="text-primary">FIRST</span>
          </span>
        </div>

        {/* Project selector */}
        <ProjectDropdown
          projectSlug={projectSlug}
          callTool={callTool}
          onProjectChange={onProjectChange}
        />

        {/* Generation shortcuts */}
        <CommandButton command="/image" icon={<ImageIcon className="w-3.5 h-3.5" />} variant="blue" onClick={() => onAnimateCommand('/image')} />
        <CommandButton command="/video" icon={<Film className="w-3.5 h-3.5" />} variant="fuchsia" onClick={() => onAnimateCommand('/video')} />
        <CommandButton command="/final" icon={<Clapperboard className="w-3.5 h-3.5" />} onClick={() => onAnimateCommand('/final')} />
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1">
        <InboxButton state={inboxState} generatingCount={generatingCount} readyCount={readyCount} flashKey={readyCount} onClick={onInboxClick} />

        <Popover open={activityOpen} onOpenChange={handleActivityOpen}>
          <PopoverTrigger asChild>
            <button className="relative flex items-center justify-center w-8 h-8 rounded text-muted-foreground/60 hover:text-muted-foreground transition-colors">
              <History className="w-4 h-4" />
              {hasFailures && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-0">
            <ActivityPanel entries={entries} loading={loading} syncResult={syncResult} />
          </PopoverContent>
        </Popover>

        <button className="flex items-center justify-center w-8 h-8 rounded text-muted-foreground/60 hover:text-muted-foreground transition-colors">
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
