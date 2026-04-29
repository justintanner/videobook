import { useRef, useCallback } from 'react';
import { Settings, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import type { Orientation } from '@/hooks/useTimeline';
import { RenderingReadout } from './RenderingReadout';
import { DownloadingReadout } from './DownloadingReadout';
import { RenderSettingsPanel } from './RenderSettingsPanel';
import type { RenderSettings } from './render-settings-types';
import { useMountKey } from '@/contexts/MountKeyContext';
import type { UseMcpResult } from 'use-mcp/react';
import { type ViewerSize, type BackTab, RENDERING_STATUSES } from './viewer-types';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import {
  RatioToggle,
  RenderPrompt,
  ViewerToolbar,
  BackFaceTabBar,
  FilesBackPane,
  HistoryBackPane,
  useViewerBackFace,
} from './viewer-shared';

// ── Video-specific components ──

function ClipContent({ item, size, onRender, callTool, projectSlug }: {
  item: MediaItem;
  size: ViewerSize;
  onRender?: () => void;
  callTool: UseMcpResult['callTool'];
  projectSlug: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleExtractFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    callTool('extract_frame', {
      asset_id: item.id,
      project_slug: projectSlug,
      timestamp: video.currentTime,
    });
  }, [callTool, item.id, projectSlug]);

  if (item.status === 'downloading') {
    return <DownloadingReadout asset={item} />;
  }

  if (!item.filePath) return null;

  if (size === 'original') {
    const thumbSrc = item.thumbnailSrc || item.filePath.replace(/\/[^/]+$/, '/original.jpg');
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="w-full h-full">
            <video ref={videoRef} key={item.filePath} src={item.filePath} poster={thumbSrc} controls tabIndex={-1} className="w-full h-full object-contain" draggable={false} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={handleExtractFrame}
            className="!flex flex-col !items-stretch gap-1.5 py-3 px-3 border-l-[3px] bg-white/[0.02] border-l-cyan-500/30 focus:!bg-white/[0.12] focus:!text-inherit focus:!border-l-[3px] focus:border-l-cyan-500/60"
          >
            <span className="text-sm font-semibold leading-none text-foreground">Extract Frame</span>
            <span className="font-mono text-muted-foreground text-xs tracking-wider leading-none">/extract-frame</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  const orient = size as Orientation;
  const renders = item.renders ?? [];
  const status = item.status;

  if (renders.includes(orient)) {
    // The final singleton's rendered outputs are `timeline_<orient>.mp4`,
    // not the bare `<orient>.mp4` that per-clip assets write.
    const prefix = item.type === 'final' ? 'timeline_' : '';
    const orientedFile = size === 'landscape' ? `${prefix}landscape.mp4`
      : size === 'portrait' ? `${prefix}portrait.mp4`
      : `${prefix}square.mp4`;
    const qIdx = item.filePath.indexOf('?');
    const qs = qIdx >= 0 ? item.filePath.slice(qIdx) : '';
    const basePath = qIdx >= 0 ? item.filePath.slice(0, qIdx) : item.filePath;
    const derivedSrc = basePath.replace(/\/[^/]+$/, `/${orientedFile}`) + qs;
    const thumbFile = size === 'landscape' ? `${prefix}landscape.jpg`
      : size === 'portrait' ? `${prefix}portrait.jpg`
      : `${prefix}square.jpg`;
    const thumbSrc = basePath.replace(/\/[^/]+$/, `/${thumbFile}`) + qs;
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="w-full h-full">
            <video ref={videoRef} key={derivedSrc} src={derivedSrc} poster={thumbSrc} controls tabIndex={-1} className="w-full h-full object-contain" draggable={false} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={handleExtractFrame}
            className="!flex flex-col !items-stretch gap-1.5 py-3 px-3 border-l-[3px] bg-white/[0.02] border-l-cyan-500/30 focus:!bg-white/[0.12] focus:!text-inherit focus:!border-l-[3px] focus:border-l-cyan-500/60"
          >
            <span className="text-sm font-semibold leading-none text-foreground">Extract Frame</span>
            <span className="font-mono text-muted-foreground text-xs tracking-wider leading-none">/extract-frame</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  if (status && RENDERING_STATUSES.has(status)) {
    return <RenderingReadout asset={item} />;
  }

  return <RenderPrompt item={item} orientation={orient} onRender={onRender} />;
}

function SettingsPane({ renderOrientation, onSizeChange, onRender, settings, onSettingsChange }: {
  renderOrientation: Orientation;
  onSizeChange: (s: ViewerSize) => void;
  onRender?: (settings: RenderSettings) => void;
  settings: RenderSettings;
  onSettingsChange: (s: RenderSettings | ((prev: RenderSettings) => RenderSettings)) => void;
}) {
  const allOrientations: Orientation[] = ['landscape', 'portrait', 'square'];

  const orientationEntries = allOrientations.map((orient) => ({
    orient,
    active: orient === renderOrientation,
  }));

  const handleApply = () => {
    onRender?.(settings);
  };

  const handleClick = (orient: Orientation) => {
    onSizeChange(orient);
  };

  const subtitleFieldMap: Record<string, keyof RenderSettings> = {
    enabled: 'subtitlesEnabled',
    style: 'subtitleStyle',
    position: 'subtitlePosition',
    fontSize: 'fontSize',
    textColor: 'textColor',
    highlightColor: 'highlightColor',
    strokeWidth: 'strokeWidth',
    strokeColor: 'strokeColor',
    shadowBlur: 'shadowBlur',
    shadowOpacity: 'shadowOpacity',
  };

  const handleSubtitleChange = (field: string, value: string | boolean | number) => {
    const key = subtitleFieldMap[field] ?? field;
    onSettingsChange({ ...settings, [key]: value });
  };

  const handleOsgChange = (field: string, value: string | boolean | null) => {
    const keyMap: Record<string, keyof RenderSettings> = {
      position: 'osgPosition',
      assetId: 'osgAssetId',
      assetSrc: 'osgAssetSrc',
    };
    const key = keyMap[field] ?? field;
    onSettingsChange(prev => ({ ...prev, [key]: value }));
  };

  const handleAudioChange = (field: string, value: number) => {
    onSettingsChange({ ...settings, [field]: value });
  };

  const handleBackgroundChange = (mode: 'blur' | 'black') => {
    onSettingsChange({ ...settings, backgroundMode: mode });
  };

  return (
    <RenderSettingsPanel
      orientations={orientationEntries}
      onOrientationClick={handleClick}
      subtitlesEnabled={settings.subtitlesEnabled}
      subtitleStyle={settings.subtitleStyle}
      subtitlePosition={settings.subtitlePosition}
      fontSize={settings.fontSize}
      textColor={settings.textColor}
      highlightColor={settings.highlightColor}
      strokeWidth={settings.strokeWidth}
      strokeColor={settings.strokeColor}
      shadowBlur={settings.shadowBlur}
      shadowOpacity={settings.shadowOpacity}
      onSubtitleChange={handleSubtitleChange}
      audioVolume={settings.audioVolume}
      audioFadeIn={settings.audioFadeIn}
      audioFadeOut={settings.audioFadeOut}
      onAudioChange={handleAudioChange}
      osgAssetId={settings.osgAssetId}
      osgAssetSrc={settings.osgAssetSrc}
      osgPosition={settings.osgPosition}
      onOsgChange={handleOsgChange}
      backgroundMode={settings.backgroundMode}
      onBackgroundChange={handleBackgroundChange}
      onApply={handleApply}
    />
  );
}

// ── VideoViewer ──

const VIDEO_BACK_TABS: BackTab[] = ['settings', 'files', 'history'];

export function VideoViewer({ item, projectSlug, size, onSizeChange, flipped, onFlippedChange, renderOrientation, onRender, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, settings, onSettingsChange, callTool, onClose }: {
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
    defaultBackTab: 'settings',
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
                    title="/settings"
                    className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
                  >
                    <Settings className="w-4 h-4 stroke-[2.5]" />
                  </button>
                  <button
                    tabIndex={-1}
                    onClick={onClose}
                    title="Close"
                    className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
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
                  <ClipContent item={item} size={size} onRender={onRender} callTool={callTool} projectSlug={projectSlug} />
                </div>
              ) : size === 'square' ? (
                <div className="aspect-square h-full max-w-full">
                  <ClipContent item={item} size={size} onRender={onRender} callTool={callTool} projectSlug={projectSlug} />
                </div>
              ) : (
                <ClipContent item={item} size={size} onRender={onRender} callTool={callTool} projectSlug={projectSlug} />
              )}
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            <BackFaceTabBar
              tabs={VIDEO_BACK_TABS}
              active={bf.backTab}
              onSelect={bf.setBackTab}
              slug={item.slug}
              onClose={() => onFlippedChange(false)}
              onCloseViewer={onClose}
            />

            {bf.backTab === 'settings' ? (
              <div className="flex-1 overflow-auto bg-black">
                <SettingsPane
                  renderOrientation={renderOrientation}
                  onSizeChange={onSizeChange}
                  onRender={onRender}
                  settings={settings}
                  onSettingsChange={onSettingsChange}
                />
              </div>
            ) : bf.backTab === 'files' ? (
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
