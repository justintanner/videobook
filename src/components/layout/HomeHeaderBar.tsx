import { Clapperboard, Film, ImageIcon, Settings, History } from 'lucide-react';
import { CommandButton, InboxButton } from '@/components/commands';
import { ProjectDropdown } from './ProjectDropdown';
import { cn } from '@/lib/utils';
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
  failureCount: number;
  onAnimateCommand: (text: string) => void;
}

export function HomeHeaderBar({ pulseKey, projectSlug, callTool, onProjectChange, inboxState, generatingCount, readyCount, onInboxClick, onStatusClick, failureCount, onAnimateCommand }: HomeHeaderBarProps) {
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
        <div className="relative">
          <CommandButton command="/activity" icon={<History className="w-3.5 h-3.5" />} variant="zinc" onClick={onStatusClick} />
          {failureCount > 0 && (
            <span
              className={cn(
                'absolute -top-1.5 -right-1.5 z-20',
                'text-[10px] font-mono font-bold leading-none px-1 min-w-[16px] h-4',
                'rounded-full inline-flex items-center justify-center',
                'bg-red-500 text-white pointer-events-none'
              )}
            >
              {failureCount}
            </span>
          )}
        </div>

        <InboxButton state={inboxState} generatingCount={generatingCount} readyCount={readyCount} flashKey={readyCount} onClick={onInboxClick} />

        <button className="flex items-center justify-center w-8 h-8 rounded text-muted-foreground/60 hover:text-muted-foreground transition-colors">
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
