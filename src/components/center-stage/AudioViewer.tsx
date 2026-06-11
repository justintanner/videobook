import { Settings, AudioLines } from 'lucide-react';
import { CloseButton } from '@/components/ui/CloseButton';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import { useMountKey } from '@/contexts/MountKeyContext';
import type { UseMcpResult } from 'use-mcp/react';
import type { BackTab } from './viewer-types';
import {
  ViewerToolbar,
  BackFaceTabBar,
  FilesBackPane,
  HistoryBackPane,
  useViewerBackFace,
} from './viewer-shared';

// ── AudioViewer ──

const AUDIO_BACK_TABS: BackTab[] = ['files', 'history'];

export function AudioViewer({ item, projectSlug, flipped, onFlippedChange, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, callTool, onClose }: {
  item: MediaItem;
  projectSlug: string;
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
      <div className="flip-card-perspective w-full h-full">
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
              left={
                <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-violet-300/70">
                  <AudioLines className="w-3.5 h-3.5" />
                  <span>AUDIO</span>
                </span>
              }
              slug={item.slug}
              right={
                <div className="flex items-center gap-1">
                  <button
                    tabIndex={-1}
                    onClick={bf.handleFlipToBack}
                    title="/files"
                    className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-violet-300 transition-colors duration-150 rounded hover:bg-violet-500/10"
                  >
                    <Settings className="w-4 h-4 stroke-[2.5]" />
                  </button>
                  <CloseButton tabIndex={-1} onClick={onClose} tone="violet" />
                </div>
              }
            />

            <div className="flex-1 bg-black flex flex-col min-h-0 items-center justify-center gap-6 px-8">
              <AudioLines className="w-16 h-16 text-violet-300/20" />
              {item.filePath && (
                <audio
                  src={item.filePath}
                  controls
                  className="w-full max-w-md"
                />
              )}
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            <BackFaceTabBar
              tabs={AUDIO_BACK_TABS}
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
