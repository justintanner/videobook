import { Clapperboard } from 'lucide-react';
import { CommandButton, InboxButton } from '@/components/commands';
import { ProjectButton } from './ProjectButton';

export function HomeHeaderBar({ pulseKey, projectSlug }: { pulseKey: number; projectSlug: string | undefined }) {
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
        <ProjectButton projectSlug={projectSlug} />

        {/* Generations */}
        <InboxButton state="inactive" generatingCount={0} readyCount={0} flashKey={0} onClick={() => {}} />
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1">
        <CommandButton command="/final" icon={<Clapperboard className="w-3.5 h-3.5" />} />
      </div>
    </div>
  );
}
