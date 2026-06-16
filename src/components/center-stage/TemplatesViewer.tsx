import { useEffect, useRef, useState } from 'react';
import { Images, LayoutTemplate, MapPin, Mic } from 'lucide-react';
import type { UseMcpResult } from 'use-mcp/react';
import { CloseButton } from '@/components/ui/CloseButton';
import { cn } from '@/lib/utils';
import { useMountKey } from '@/contexts/MountKeyContext';
import { ViewerToolbar } from './viewer-shared';
import type { PlanFormula } from './PlanViewer';

// Derive the current plan's formula straight from the read_plan JSON. A sidecar
// with no (or unknown) formula is the legacy char-swap plan.
function formulaFromPlanJson(text: string): PlanFormula | null {
  try {
    const parsed = JSON.parse(text) as { formula?: string };
    if (parsed.formula === 'clip_show') return 'clip_show';
    if (parsed.formula === 'storyboard_video') return 'storyboard_video';
    return 'char_swap';
  } catch {
    return null;
  }
}

interface TemplatesViewerProps {
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onSelectTemplate: (formula: PlanFormula) => void;
  onClose: () => void;
}

export function TemplatesViewer({ projectSlug, callTool, onSelectTemplate, onClose }: TemplatesViewerProps) {
  useMountKey('viewer');
  const [currentFormula, setCurrentFormula] = useState<PlanFormula | null>(null);
  const cancelledRef = useRef(false);

  // Read the existing plan (if any) to highlight the current template and to
  // surface the legacy char-swap card. A read failure means "no plan yet".
  useEffect(() => {
    if (!projectSlug) return;
    cancelledRef.current = false;
    void (async () => {
      const result = await callTool('read_plan', { project_slug: projectSlug });
      if (cancelledRef.current) return;
      if (result.isError) {
        setCurrentFormula(null);
        return;
      }
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      setCurrentFormula(formulaFromPlanJson(text));
    })();
    return () => { cancelledRef.current = true; };
  }, [callTool, projectSlug]);

  return (
    <TemplatesShell onClose={onClose}>
      <div
        className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden scrollbar-domain"
        style={{ '--scrollbar-rgb': '45, 212, 191' } as React.CSSProperties}
      >
        <div className="w-full min-w-0 px-4 sm:px-6 py-5">
          <TemplateChooser currentFormula={currentFormula} onSelect={onSelectTemplate} />
        </div>
      </div>
    </TemplatesShell>
  );
}

function TemplatesShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-0 flex items-center justify-center overflow-hidden">
      <div className="w-full h-full min-w-0 relative">
        <div className="absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
          <ViewerToolbar
            left={
              <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-teal-300/90 drop-shadow-[0_0_4px_rgba(45,212,191,0.5)]">
                <LayoutTemplate className="w-3.5 h-3.5" />
                <span>TEMPLATES</span>
              </span>
            }
            slug="pick a template"
            right={<CloseButton tabIndex={-1} onClick={onClose} tone="teal" />}
          />
          <div className="flex-1 min-w-0 bg-black flex flex-col min-h-0 relative">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function TemplateChooser({ currentFormula, onSelect }: {
  currentFormula: PlanFormula | null;
  onSelect: (formula: PlanFormula) => void;
}) {
  const templates: Array<{ id: Exclude<PlanFormula, 'char_swap'>; label: string; icon: React.ReactNode; meta: string }> = [
    { id: 'clip_show', label: 'Clip Show', icon: <Mic className="w-4 h-4" />, meta: 'char-* + vid-*' },
    { id: 'storyboard_video', label: 'Storyboard', icon: <Images className="w-4 h-4" />, meta: 'img-*' },
  ];
  return (
    <div className="min-h-full flex flex-col">
      <div className="mb-5 pb-4 border-b border-zinc-800/70">
        <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-teal-300/45">Plan</div>
        <h1 className="mt-1 text-lg font-bold text-teal-300 font-mono uppercase tracking-wider">Templates</h1>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {templates.map((template) => {
          const isCurrent = currentFormula === template.id;
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelect(template.id)}
              className={cn(
                'min-h-32 p-4 rounded border text-left transition-colors',
                'bg-zinc-950/50 hover:bg-teal-500/10',
                isCurrent ? 'border-teal-500/65' : 'border-zinc-800/75 hover:border-teal-500/50',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn(
                    'w-8 h-8 rounded border flex items-center justify-center shrink-0',
                    isCurrent ? 'border-teal-500/70 text-teal-200 bg-teal-500/15' : 'border-zinc-700/80 text-teal-300/65 bg-black/35',
                  )}>
                    {template.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-mono font-bold uppercase tracking-wider text-teal-200 truncate">{template.label}</span>
                    <span className="block mt-0.5 text-[10px] font-mono uppercase tracking-wider text-teal-300/40 truncate">{template.meta}</span>
                  </span>
                </div>
                {isCurrent && (
                  <span className="shrink-0 h-5 px-2 rounded border border-teal-500/40 bg-teal-500/10 text-[9px] font-mono font-bold uppercase tracking-wider text-teal-200/80">
                    Current
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {currentFormula === 'char_swap' && (
        <button
          type="button"
          onClick={() => onSelect('char_swap')}
          className={cn(
            'mt-4 w-full min-h-20 p-4 rounded border text-left transition-colors',
            'bg-zinc-950/40 hover:bg-teal-500/10 border-zinc-800/75 hover:border-teal-500/45',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-8 h-8 rounded border border-zinc-700/80 flex items-center justify-center shrink-0 text-teal-300/55 bg-black/35">
                <MapPin className="w-4 h-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-mono font-bold uppercase tracking-wider text-teal-200 truncate">Legacy Plan</span>
                <span className="block mt-0.5 text-[10px] font-mono uppercase tracking-wider text-teal-300/35 truncate">char swap</span>
              </span>
            </div>
            <span className="shrink-0 h-5 px-2 rounded border border-teal-500/35 bg-teal-500/10 text-[9px] font-mono font-bold uppercase tracking-wider text-teal-200/70">
              Current
            </span>
          </div>
        </button>
      )}
    </div>
  );
}
