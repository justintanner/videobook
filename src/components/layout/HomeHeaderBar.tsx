import { Clapperboard, Film, ImageIcon, Settings } from 'lucide-react';
import { CommandButton, InboxButton } from '@/components/commands';
import { ProjectDropdown } from './ProjectDropdown';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
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
  const { dispatch } = useCommandDispatch();
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
        <CommandButton command="/image" icon={<ImageIcon className="w-3.5 h-3.5" />} variant="blue" onClick={() => dispatch('/image')} />
        <CommandButton command="/video" icon={<Film className="w-3.5 h-3.5" />} variant="fuchsia" onClick={() => dispatch('/video')} />
        <CommandButton command="/final" icon={<Clapperboard className="w-3.5 h-3.5" />} onClick={() => dispatch('/final')} />
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1">
        <InboxButton state={inboxState} generatingCount={generatingCount} readyCount={readyCount} flashKey={readyCount} onClick={onInboxClick} />
        <button className="flex items-center justify-center w-8 h-8 rounded text-muted-foreground/60 hover:text-muted-foreground transition-colors">
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
