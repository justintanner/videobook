import { Clapperboard, Film, ImageIcon, MapPin, Settings, History } from 'lucide-react';
import { CommandButton } from '@/components/commands';
import { ProjectDropdown } from './ProjectDropdown';
import type { UseMcpResult } from 'use-mcp/react';

interface HomeHeaderBarProps {
  pulseKey: number;
  projectSlug: string | undefined;
  assetCount: number | undefined;
  callTool: UseMcpResult['callTool'];
  onProjectChange: (slug: string) => void;
  onStatusClick: () => void;
  onAnimateCommand: (text: string) => void;
}

export function HomeHeaderBar({ pulseKey, projectSlug, assetCount, callTool, onProjectChange, onStatusClick, onAnimateCommand }: HomeHeaderBarProps) {
  return (
    <div className="bg-card border-b border-border flex items-center justify-between px-2 h-12">
      <div className="flex items-center gap-1">
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 h-full">
          <div key={pulseKey} className="w-2.5 h-2.5 rounded-full bg-primary shrink-0 logo-dot-pulse" />
          <span className="font-mono font-bold text-sm uppercase tracking-wider">
            <span className="text-foreground">VIDEO</span>
            <span className="text-primary">CITY</span>
          </span>
        </div>

        {/* Project selector */}
        <ProjectDropdown
          projectSlug={projectSlug}
          assetCount={assetCount}
          callTool={callTool}
          onProjectChange={onProjectChange}
        />

        {/* Generation shortcuts */}
        <CommandButton command="/plan" icon={<MapPin className="w-3.5 h-3.5" />} variant="plan" onClick={() => onAnimateCommand('/plan')} />
        <CommandButton command="/image" icon={<ImageIcon className="w-3.5 h-3.5" />} variant="image" onClick={() => onAnimateCommand('/image')} />
        <CommandButton command="/video" icon={<Film className="w-3.5 h-3.5" />} variant="video" onClick={() => onAnimateCommand('/video')} />
        <CommandButton command="/final" icon={<Clapperboard className="w-3.5 h-3.5" />} variant="final" onClick={() => onAnimateCommand('/final')} />
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1">
        <CommandButton command="/activity" icon={<History className="w-3.5 h-3.5" />} variant="projects" onClick={onStatusClick} />

        <button className="flex items-center justify-center w-8 h-8 rounded text-muted-foreground/60 hover:text-muted-foreground transition-colors">
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
