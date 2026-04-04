import { Clapperboard, Film, ImageIcon, Settings, History } from 'lucide-react';
import { CommandButton, InboxButton } from '@/components/commands';
import { ProjectDropdown } from './ProjectDropdown';
import type { UseMcpResult } from 'use-mcp/react';

interface HomeHeaderBarProps {
  pulseKey: number;
  projectSlug: string | undefined;
  callTool: UseMcpResult['callTool'];
  onProjectChange: (slug: string) => void;
  inboxState: 'inactive' | 'generating' | 'ready';
  generatingCount: number;
  readyCount: number;
  onInboxClick: () => void;
  onStatusClick: () => void;
  hasFailures: boolean;
  onAnimateCommand: (text: string) => void;
}

export function HomeHeaderBar({ pulseKey, projectSlug, callTool, onProjectChange, inboxState, generatingCount, readyCount, onInboxClick, onStatusClick, hasFailures, onAnimateCommand }: HomeHeaderBarProps) {
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

        <div className="relative">
          <CommandButton command="/status" icon={<History className="w-3.5 h-3.5" />} variant="zinc" onClick={onStatusClick} />
          {hasFailures && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 pointer-events-none" />
          )}
        </div>

        <button className="flex items-center justify-center w-8 h-8 rounded text-muted-foreground/60 hover:text-muted-foreground transition-colors">
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
