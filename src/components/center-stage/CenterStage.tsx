import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import type { Orientation } from '@/hooks/useTimeline';
import type { RenderSettings, TranscriptInfo } from './render-settings-types';
import type { UseMcpResult } from 'use-mcp/react';
import { VideoViewer } from './VideoViewer';
import type { OsgApplyValue } from './OsgOverlay';
import { ImageViewer } from './ImageViewer';
import { ScriptViewer } from './ScriptViewer';
import { AudioViewer } from './AudioViewer';
import { CharacterFolderViewer } from './CharacterFolderViewer';
import { Notebook } from './notebook/PlanNotebook';
import type { ViewerSize, BackTab } from './viewer-types';
import type { OnGenerationLifecycle } from '@/lib/generation-lifecycle';

// ── AssetViewer Dispatcher ──

export function AssetViewer({ item, projectSlug, size, onSizeChange, flipped, onFlippedChange, renderOrientation, onRender, onSplitAtCursor, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, settings, onSettingsChange, transcript, callTool, callState, onClose, imageAssets, mediaItems, onOpenAsset, cropTarget, onCropConsumed, osgTarget, onOsgConsumed, onOsgApply, onGenerationLifecycle, onManageCharacters }: {
  item: MediaItem;
  projectSlug: string;
  size: ViewerSize;
  onSizeChange: (s: ViewerSize) => void;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
  renderOrientation: Orientation;
  onRender?: (settings?: RenderSettings) => void;
  onSplitAtCursor?: (assetId: string, atSec: number) => void;
  pendingFilePosition?: number | null;
  onClearPendingFilePosition?: () => void;
  pendingBackTab?: BackTab | null;
  onClearPendingBackTab?: () => void;
  settings: RenderSettings;
  onSettingsChange: (s: RenderSettings | ((prev: RenderSettings) => RenderSettings)) => void;
  transcript?: TranscriptInfo | null;
  callTool: UseMcpResult['callTool'];
  callState: UseMcpResult['state'];
  onClose: () => void;
  imageAssets: MediaItem[];
  mediaItems: MediaItem[];
  onOpenAsset?: (assetId: string) => void;
  cropTarget?: { assetId: string; ratio?: string } | null;
  onCropConsumed?: () => void;
  osgTarget?: { assetId: string; osgAssetId?: string } | null;
  onOsgConsumed?: () => void;
  onOsgApply?: (assetId: string, value: OsgApplyValue | null) => void;
  onGenerationLifecycle?: OnGenerationLifecycle;
  onManageCharacters?: () => void;
}) {
  const isClip = item.type === 'video' || item.type === 'final';
  const isNotebook = item.type === 'notebook';
  const isScript = item.type === 'script';
  const isAudio = item.type === 'audio';
  const isCharacter = item.type === 'character';
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
        onSplitAtCursor={item.type === 'video' ? onSplitAtCursor : undefined}
        pendingFilePosition={pendingFilePosition}
        onClearPendingFilePosition={onClearPendingFilePosition}
        pendingBackTab={pendingBackTab}
        onClearPendingBackTab={onClearPendingBackTab}
        settings={settings}
        onSettingsChange={onSettingsChange}
        transcript={transcript}
        callTool={callTool}
        onClose={onClose}
        cropTarget={cropTarget}
        onCropConsumed={onCropConsumed}
        osgTarget={osgTarget}
        onOsgConsumed={onOsgConsumed}
        onOsgApply={onOsgApply}
        imageAssets={imageAssets}
      />
    );
  }

  if (isNotebook) {
    return (
      <Notebook
        notebookId={item.id}
        projectSlug={projectSlug}
        callTool={callTool}
        mcpState={callState}
        mediaItems={mediaItems}
        onClose={onClose}
        onOpenAsset={onOpenAsset}
        onGenerationLifecycle={onGenerationLifecycle}
        onManageCharacters={onManageCharacters}
      />
    );
  }

  if (isScript) {
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
        onClose={onClose}
      />
    );
  }


  if (isAudio) {
    return (
      <AudioViewer
        item={item}
        projectSlug={projectSlug}
        flipped={flipped}
        onFlippedChange={onFlippedChange}
        pendingFilePosition={pendingFilePosition}
        onClearPendingFilePosition={onClearPendingFilePosition}
        pendingBackTab={pendingBackTab}
        onClearPendingBackTab={onClearPendingBackTab}
        callTool={callTool}
        onClose={onClose}
      />
    );
  }

  if (isCharacter) {
    return (
      <CharacterFolderViewer
        item={item}
        projectSlug={projectSlug}
        callTool={callTool}
        onClose={onClose}
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
      onClose={onClose}
    />
  );
}

// ── Shells ──

function AssetViewShell({ fillParent, children }: { fillParent: boolean; children: React.ReactNode }) {
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
