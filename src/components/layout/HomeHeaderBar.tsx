import { Clapperboard } from 'lucide-react';
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
}

export function HomeHeaderBar({ pulseKey, projectSlug, callTool, onProjectChange, inboxState, generatingCount, readyCount, onInboxClick }: HomeHeaderBarProps) {
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

        {/* Generations */}
        <InboxButton state={inboxState} generatingCount={generatingCount} readyCount={readyCount} flashKey={readyCount} onClick={onInboxClick} />
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1">
        <CommandButton command="/final" icon={<Clapperboard className="w-3.5 h-3.5" />} />
      </div>
    </div>
  );
}
