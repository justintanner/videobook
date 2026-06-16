import { useEffect, useRef, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import type { UseMcpResult } from 'use-mcp/react';
import { CloseButton } from '@/components/ui/CloseButton';
import type { MediaItem } from '@/components/sidebar/types';
import { useMountKey } from '@/contexts/MountKeyContext';
import { ViewerToolbar } from './viewer-shared';
import type { PlanFormula } from './PlanViewer';
import { TemplatesHome } from './templates/TemplatesHome';
import { TemplatePreview } from './templates/TemplatePreview';
import type { TemplateCatalogEntry } from './templates/catalog';

// Derive the current plan's formula straight from the read_plan JSON, to flag
// the matching template card as "Current". A sidecar with no (or unknown)
// formula is the legacy char-swap plan.
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
  mediaItems: MediaItem[];
  callTool: UseMcpResult['callTool'];
  // Called after a plan has been generated from a template preview — navigate
  // to /plan to work on it.
  onGenerated: () => void;
  onClose: () => void;
}

export function TemplatesViewer({ projectSlug, mediaItems, callTool, onGenerated, onClose }: TemplatesViewerProps) {
  useMountKey('viewer');
  const [selected, setSelected] = useState<TemplateCatalogEntry | null>(null);
  const [currentFormula, setCurrentFormula] = useState<PlanFormula | null>(null);
  const cancelledRef = useRef(false);

  // Read the existing plan (if any) to highlight the current template.
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
    <TemplatesShell slug={selected ? selected.name.toLowerCase() : 'pick a template'} onClose={onClose}>
      <div
        className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden scrollbar-domain"
        style={{ '--scrollbar-rgb': '45, 212, 191' } as React.CSSProperties}
      >
        <div className="w-full min-w-0 px-4 sm:px-6 py-5">
          {selected ? (
            <TemplatePreview
              entry={selected}
              projectSlug={projectSlug}
              mediaItems={mediaItems}
              callTool={callTool}
              onBack={() => setSelected(null)}
              onGenerated={onGenerated}
            />
          ) : (
            <TemplatesHome currentFormula={currentFormula} onOpen={setSelected} />
          )}
        </div>
      </div>
    </TemplatesShell>
  );
}

function TemplatesShell({ slug, onClose, children }: { slug: string; onClose: () => void; children: React.ReactNode }) {
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
            slug={slug}
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
