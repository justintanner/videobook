import { ArchiveRestore, Loader2, NotebookPen, Settings, History } from 'lucide-react';
import { CommandButton } from '@/components/commands';
import { ProjectDropdown } from './ProjectDropdown';
import { useToast } from '@/hooks/useToast';
import type { UseMcpResult } from 'use-mcp/react';

interface HomeHeaderBarProps {
  pulseKey: number;
  bookId: string | undefined;
  assetCount: number | undefined;
  /** Number of assets currently rendering — shows a global rendering indicator. */
  renderingCount?: number;
  /** Header label + command for the notebook shortcut, e.g. "/notebook scratch". */
  notebookCommand: string;
  callTool: UseMcpResult['callTool'];
  onProjectChange: (slug: string) => void;
  onStatusClick: () => void;
  onArchiveClick: () => void;
  onSettingsClick: () => void;
  onAnimateCommand: (text: string) => void;
  archiveActive?: boolean;
  settingsActive?: boolean;
  projectsOpen?: boolean;
  onProjectsOpenChange?: (open: boolean) => void;
}

export function HomeHeaderBar({ pulseKey, bookId, assetCount, renderingCount = 0, notebookCommand, callTool, onProjectChange, onStatusClick, onArchiveClick, onSettingsClick, onAnimateCommand, archiveActive = false, settingsActive = false, projectsOpen, onProjectsOpenChange }: HomeHeaderBarProps) {
  const { toasts } = useToast();
  const hasOpenToast = toasts.some((toast) => toast.open);
  const isRendering = renderingCount > 0;

  return (
    <div className="bg-card border-b border-border flex items-center justify-between px-2 h-12">
      <div className="flex items-center gap-1">
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 h-full">
 <div key={pulseKey} className="size-2.5 rounded-full bg-primary shrink-0 logo-dot-pulse" />
          <span className="font-mono font-bold text-sm uppercase tracking-wider">
            <span className="text-foreground">VIDEO</span>
            <span className="text-primary">CITY</span>
          </span>
        </div>

        {/* Project selector */}
        <ProjectDropdown
          bookId={bookId}
          assetCount={assetCount}
          callTool={callTool}
          onProjectChange={onProjectChange}
          open={projectsOpen}
          onOpenChange={onProjectsOpenChange}
        />

        {/* Generation shortcuts */}
	<CommandButton command={notebookCommand} icon={<NotebookPen className="size-3.5" />} variant="notebook" onClick={() => onAnimateCommand(notebookCommand)} />
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1">
        {isRendering && (
          <button
            type="button"
            onClick={onStatusClick}
            title={`${renderingCount} clip${renderingCount > 1 ? 's' : ''} rendering`}
            className="flex items-center gap-1.5 h-8 px-2.5 rounded bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
          >
 <Loader2 className="size-3.5 animate-spin" />
            <span className="font-mono text-xs tracking-wider">
              rendering{renderingCount > 1 ? ` ×${renderingCount}` : ''}
            </span>
          </button>
        )}

        <CommandButton
          command="/activity"
 icon={<History className="size-3.5" />}
          variant="projects"
          onClick={onStatusClick}
          className={hasOpenToast ? 'toast-origin-pulse border-emerald-500/60' : undefined}
        />

        <button
          type="button"
          onClick={onArchiveClick}
 className={`flex items-center justify-center size-8 rounded transition-colors ${archiveActive ? 'text-amber-300 bg-amber-500/10' : 'text-muted-foreground/60 hover:text-amber-300/80 hover:bg-amber-500/10'}`}
          title="Archive"
        >
 <ArchiveRestore className="size-4" />
        </button>

        <button
          type="button"
          onClick={onSettingsClick}
 className={`flex items-center justify-center size-8 rounded transition-colors ${settingsActive ? 'text-primary bg-primary/10' : 'text-muted-foreground/60 hover:text-primary hover:bg-primary/10'}`}
          title="Settings"
        >
 <Settings className="size-4" />
        </button>
      </div>
    </div>
  );
}
