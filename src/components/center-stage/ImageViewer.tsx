import { useEffect, useRef } from 'react';
import { Settings, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import { useMountKey } from '@/contexts/MountKeyContext';
import { isFailedPending } from '@/components/commands/inbox-utils';
import type { UseMcpResult } from 'use-mcp/react';
import type { ViewerSize, BackTab } from './viewer-types';
import {
  CropImage,
  RatioToggle,
  ViewerToolbar,
  BackFaceTabBar,
  FilesBackPane,
  HistoryBackPane,
  useViewerBackFace,
} from './viewer-shared';

// ── Image content renderer ──

function ImageContent({ item, size }: { item: MediaItem; size: ViewerSize }) {
  if (!item.filePath) return null;

  if (size === 'original') {
    return (
      <img
        src={item.filePath}
        alt={item.title}
        className="w-full h-full object-contain"
        draggable={false}
      />
    );
  }

  const cropFile = size === 'landscape' ? 'landscape.jpg'
    : size === 'portrait' ? 'portrait.jpg'
    : 'square.jpg';
  const cropSrc = item.filePath.replace(/\/[^/]+$/, `/${cropFile}`);
  return (
    <CropImage key={cropSrc} cropSrc={cropSrc} fallbackSrc={item.filePath} alt={item.title} />
  );
}

// ── ImageViewer ──

const IMAGE_BACK_TABS: BackTab[] = ['files', 'history'];

export function ImageViewer({ item, projectSlug, size, onSizeChange, flipped, onFlippedChange, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, callTool, onClose }: {
  item: MediaItem;
  projectSlug: string;
  size: ViewerSize;
  onSizeChange: (s: ViewerSize) => void;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
  pendingFilePosition?: number | null;
  onClearPendingFilePosition?: () => void;
  pendingBackTab?: BackTab | null;
  onClearPendingBackTab?: () => void;
  callTool: UseMcpResult['callTool'];
  onClose: () => void;
}) {
  useMountKey('viewer');

  // Auto-flip to back face when the asset is failed and has no image to show —
  // the back face exposes the generation-error file and commit history.
  const lastAutoFlippedId = useRef<string | null>(null);
  useEffect(() => {
    if (lastAutoFlippedId.current === item.id) return;
    if (isFailedPending(item) && !item.filePath) {
      lastAutoFlippedId.current = item.id;
      if (!flipped) onFlippedChange(true);
    }
  }, [item, flipped, onFlippedChange]);

  const bf = useViewerBackFace({
    projectSlug,
    itemId: item.id,
    callTool,
    flipped,
    onFlippedChange,
    pendingFilePosition,
    onClearPendingFilePosition,
    pendingBackTab,
    onClearPendingBackTab,
    defaultBackTab: 'files',
  });

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div
        className={cn(
          'flip-card-perspective',
          size === 'original' ? 'w-full h-full'
          : size === 'landscape' ? 'aspect-video w-full h-full'
          : size === 'square' ? 'aspect-square w-full h-full'
          : 'w-full h-full',
        )}
      >
        <div className={cn(
          'flip-card-inner w-full h-full relative',
          flipped && 'flipped',
        )}>
          {/* FRONT FACE */}
          <div className={cn(
            'flip-card-face absolute inset-0 flex flex-col overflow-hidden',
            'border border-zinc-600/50',
          )}>
            <ViewerToolbar
              left={<RatioToggle active={size} onSelect={onSizeChange} item={item} />}
              slug={item.slug}
              right={
                <div className="flex items-center gap-1">
                  <button
                    tabIndex={-1}
                    onClick={bf.handleFlipToBack}
                    title="/files"
                    className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-cyan-300 transition-colors duration-150 rounded hover:bg-cyan-500/10"
                  >
                    <Settings className="w-4 h-4 stroke-[2.5]" />
                  </button>
                  <button
                    tabIndex={-1}
                    onClick={onClose}
                    title="Close"
                    className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-cyan-300 transition-colors duration-150 rounded hover:bg-cyan-500/10"
                  >
                    <X className="w-4 h-4 stroke-[2.5]" />
                  </button>
                </div>
              }
            />

            <div className={cn(
              'flex-1 bg-black flex min-h-0 items-center justify-center',
              (size === 'portrait' || size === 'square') && 'py-2',
            )}>
              {size === 'portrait' ? (
                <div className="aspect-[9/16] h-full max-w-full">
                  <ImageContent item={item} size={size} />
                </div>
              ) : size === 'square' ? (
                <div className="aspect-square h-full max-w-full">
                  <ImageContent item={item} size={size} />
                </div>
              ) : (
                <ImageContent item={item} size={size} />
              )}
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            <BackFaceTabBar
              tabs={IMAGE_BACK_TABS}
              active={bf.backTab}
              onSelect={bf.setBackTab}
              slug={item.slug}
              onClose={() => onFlippedChange(false)}
              onCloseViewer={onClose}
            />

            {bf.backTab === 'files' ? (
              <FilesBackPane
                manifest={bf.manifest}
                manifestLoading={bf.manifestLoading}
                selectedFile={bf.selectedFile}
                fileContent={bf.fileContent}
                fileLoading={bf.fileLoading}
                fileUrl={bf.fileUrl}
                handleSelectFile={bf.handleSelectFile}
                handleFileKeyDown={bf.handleFileKeyDown}
                fetchManifest={bf.fetchManifest}
                fetchFileContent={bf.fetchFileContent}
              />
            ) : (
              <HistoryBackPane
                commits={bf.commits}
                historyLoading={bf.historyLoading}
                selectedCommitHash={bf.selectedCommitHash}
                setSelectedCommitHash={bf.setSelectedCommitHash}
                handleRestore={bf.handleRestore}
                fetchHistory={bf.fetchHistory}
                itemId={item.id}
                projectSlug={projectSlug}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
