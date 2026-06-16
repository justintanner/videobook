import { ArrowLeft } from 'lucide-react';
import type { UseMcpResult } from 'use-mcp/react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import { CharSwapSetup, StoryboardSetup, ClipShowSetup } from '../PlanViewer';
import type { TemplateCatalogEntry } from './catalog';

// Marketplace detail/preview page: an app-store-style showcase — large icon
// hero + description, then the per-formula setup panel which leads with a big
// "Use Template" CTA (auto-picks inputs) and a collapsed Customize expander. On
// generate, the parent navigates to /plan to work on the new plan.
export function TemplatePreview({ entry, projectSlug, mediaItems, callTool, onBack, onGenerated }: {
  entry: TemplateCatalogEntry;
  projectSlug: string;
  mediaItems: MediaItem[];
  callTool: UseMcpResult['callTool'];
  onBack: () => void;
  onGenerated: () => void;
}) {
  const setupProps = { projectSlug, mediaItems, callTool, onGenerated };
  return (
    <div className="min-h-full flex flex-col">
      <div className="mb-4">
        <button
          type="button"
          onClick={onBack}
          title="Back to templates"
          className={cn(
            'h-8 px-2.5 flex items-center gap-1.5 rounded',
            'text-[10px] font-mono font-bold uppercase tracking-wider',
            'text-teal-300/65 hover:text-teal-200',
            'bg-zinc-950/60 hover:bg-teal-500/10 border border-zinc-700/70 hover:border-teal-500/50',
            'transition-colors duration-150',
          )}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Templates
        </button>
      </div>

      <div className="mb-5 pb-5 border-b border-zinc-800/70">
        <div className="flex items-center gap-4">
          <span className="w-20 h-20 rounded-lg border border-teal-500/40 bg-teal-500/10 text-teal-200 flex items-center justify-center shrink-0 shadow-[0_0_24px_rgba(45,212,191,0.18)]">
            <entry.icon className="w-9 h-9" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-teal-300 font-mono uppercase tracking-wider truncate">{entry.name}</h1>
            <p className="mt-1 text-xs font-mono text-teal-300/50">{entry.tagline}</p>
          </div>
        </div>
        <p className="mt-4 text-xs font-mono text-zinc-300/80 leading-relaxed">{entry.description}</p>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-teal-300/45 mb-1">What it produces</div>
            <p className="text-[11px] font-mono text-zinc-400 leading-relaxed">{entry.produces}</p>
          </div>
          <div>
            <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-teal-300/45 mb-1">Inputs required</div>
            <ul className="space-y-0.5">
              {entry.inputs.map((inp) => (
                <li key={inp} className="text-[11px] font-mono text-zinc-400 leading-relaxed flex gap-1.5">
                  <span className="text-teal-300/40">·</span>
                  <span>{inp}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {entry.id === 'clip_show' ? (
        <ClipShowSetup {...setupProps} />
      ) : entry.id === 'storyboard_video' ? (
        <StoryboardSetup {...setupProps} />
      ) : (
        <CharSwapSetup {...setupProps} />
      )}
    </div>
  );
}
