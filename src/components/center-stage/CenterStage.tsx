import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import type { Orientation } from '@/hooks/useTimeline';
import type { RenderSettings } from './render-settings-types';
import type { UseMcpResult } from 'use-mcp/react';
import { VideoViewer } from './VideoViewer';
import { ImageViewer } from './ImageViewer';
import { ScriptViewer } from './ScriptViewer';
import type { ViewerSize, BackTab } from './viewer-types';

// Re-export shared types and components so existing imports keep working
export type { ViewerSize, ManifestFile, BackTab } from './viewer-types';
export { RatioToggle, FileListPane, FileContentPane, RenderPrompt, BackFaceTabBar } from './viewer-shared';

// ── AssetViewer Dispatcher ──

export function AssetViewer({ item, projectSlug, size, onSizeChange, flipped, onFlippedChange, renderOrientation, onRender, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, settings, onSettingsChange, callTool }: {
  item: MediaItem;
  projectSlug: string;
  size: ViewerSize;
  onSizeChange: (s: ViewerSize) => void;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
  renderOrientation: Orientation;
  onRender?: (settings?: RenderSettings) => void;
  pendingFilePosition?: number | null;
  onClearPendingFilePosition?: () => void;
  pendingBackTab?: BackTab | null;
  onClearPendingBackTab?: () => void;
  settings: RenderSettings;
  onSettingsChange: (s: RenderSettings | ((prev: RenderSettings) => RenderSettings)) => void;
  callTool: UseMcpResult['callTool'];
}) {
  const isClip = item.type === 'video' || item.type === 'final';
  const isText = item.type === 'script' || item.type === 'plan';

  if (isClip) {
    return (
      <VideoViewer
        item={item}
        projectSlug={projectSlug}
        size={size}
        onSizeChange={onSizeChange}
        flipped={flipped}
        onFlippedChange={onFlippedChange}
        renderOrientation={renderOrientation}
        onRender={onRender}
        pendingFilePosition={pendingFilePosition}
        onClearPendingFilePosition={onClearPendingFilePosition}
        pendingBackTab={pendingBackTab}
        onClearPendingBackTab={onClearPendingBackTab}
        settings={settings}
        onSettingsChange={onSettingsChange}
        callTool={callTool}
      />
    );
  }

  if (isText) {
    return (
      <ScriptViewer
        item={item}
        projectSlug={projectSlug}
        flipped={flipped}
        onFlippedChange={onFlippedChange}
        pendingFilePosition={pendingFilePosition}
        onClearPendingFilePosition={onClearPendingFilePosition}
        pendingBackTab={pendingBackTab}
        onClearPendingBackTab={onClearPendingBackTab}
        callTool={callTool}
      />
    );
  }

  return (
    <ImageViewer
      item={item}
      projectSlug={projectSlug}
      size={size}
      onSizeChange={onSizeChange}
      flipped={flipped}
      onFlippedChange={onFlippedChange}
      pendingFilePosition={pendingFilePosition}
      onClearPendingFilePosition={onClearPendingFilePosition}
      pendingBackTab={pendingBackTab}
      onClearPendingBackTab={onClearPendingBackTab}
      callTool={callTool}
    />
  );
}

// ── Shells ──

export function AssetViewShell({ fillParent, children }: { fillParent: boolean; children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div
        className={cn(
          'bg-black border-2 border-border/50 relative shadow-lg group',
          fillParent ? 'w-full h-full' : 'w-full max-w-4xl aspect-video'
        )}
      >
        <div className="w-full h-full flex items-center justify-center bg-zinc-900 relative overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}

export function IdleScreen({
  label,
  badge,
  fillParent = false,
}: {
  label: string;
  badge?: string;
  fillParent?: boolean;
}) {
  return (
    <AssetViewShell fillParent={fillParent}>
      <div className="text-center space-y-4">
        <div className="w-16 h-16 rounded-full border border-primary/30 flex items-center justify-center mx-auto animate-pulse">
          <div className="w-12 h-12 rounded-full bg-primary/10" />
        </div>
        <p className="font-mono text-primary/50 text-sm">{label}</p>
      </div>
      {badge && (
        <div className="absolute top-4 left-4 font-mono text-sm text-primary/80 bg-black/50 px-2 py-1 border border-primary/20">
          {badge}
        </div>
      )}
    </AssetViewShell>
  );
}
