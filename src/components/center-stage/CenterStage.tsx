import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Settings, ChevronDown, RotateCcw, AudioLines, FileText, Monitor, Smartphone, Square, Check, VideoOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { MediaItem, ClipState } from '@/components/sidebar/types';
import type { Orientation } from '@/hooks/useTimeline';
import { RenderingReadout } from './RenderingReadout';
import { RenderSettingsPanel } from './RenderSettingsPanel';
import type { ExecuteButtonState } from '@/components/commands/types';
import type { RenderSettings } from './render-settings-types';
import { useMountKey } from '@/contexts/MountKeyContext';

export type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';

function CropImage({ cropSrc, fallbackSrc, alt }: { cropSrc: string; fallbackSrc: string; alt: string }) {
  const fell = useRef(false);
  const [src, setSrc] = useState(cropSrc);

  return (
    <img
      src={src}
      alt={alt}
      className="w-full h-full object-contain"
      draggable={false}
      onError={() => {
        if (!fell.current) {
          fell.current = true;
          setSrc(fallbackSrc);
        }
      }}
    />
  );
}

function ImageViewer({ item, size }: { item: MediaItem; size: ViewerSize }) {
  if (item.type === 'image') {
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

  if (item.type === 'audio') {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <AudioLines className="w-16 h-16 text-primary/30" />
      </div>
    );
  }

  if (item.type === 'script' || item.type === 'plan') {
    return (
      <div className="flex items-center justify-center w-full h-full p-6">
        {item.prompt ? (
          <p className="text-sm leading-relaxed text-primary/50 whitespace-pre-wrap line-clamp-[12] max-w-lg">{item.prompt}</p>
        ) : (
          <FileText className="w-16 h-16 text-primary/20" />
        )}
      </div>
    );
  }

  return null;
}


function RenderPrompt({ item, onRender }: {
  item: MediaItem;
  onRender?: () => void;
}) {
  return (
    <div className="w-full h-full bg-black flex flex-col items-center justify-center gap-3">
      <VideoOff className="w-10 h-10 text-muted-foreground/20" />
      <button
        onClick={() => onRender?.()}
        className={cn(
          'px-4 py-2 rounded border font-mono text-xs font-bold tracking-wider transition-colors',
          item.type === 'final'
            ? 'text-amber-400 border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20'
            : 'text-primary border-primary/40 bg-primary/10 hover:bg-primary/20',
        )}
      >
        /render
      </button>
    </div>
  );
}

function ClipContent({ item, size, onRender }: {
  item: MediaItem;
  size: ViewerSize;
  onRender?: () => void;
}) {
  if (!item.filePath) return null;

  if (size === 'original') {
    const thumbSrc = item.thumbnailSrc || item.filePath.replace(/\/[^/]+$/, '/original.jpg');
    return <video key={`${item.id}-${size}`} src={item.filePath} poster={thumbSrc} controls tabIndex={-1} className="w-full h-full object-contain" draggable={false} />;
  }

  const orient = size as Orientation;
  const renders = item.renders ?? [];
  const status = item.status;

  if (renders.includes(orient)) {
    const orientedFile = size === 'landscape' ? 'landscape.mp4'
      : size === 'portrait' ? 'portrait.mp4'
      : 'square.mp4';
    const derivedSrc = item.filePath.replace(/\/[^/]+$/, `/${orientedFile}`);
    const thumbSrc = item.thumbnailSrc || item.filePath.replace(/\/[^/]+$/, '/original.jpg');
    return <video key={`${item.id}-${size}`} src={derivedSrc} poster={thumbSrc} controls tabIndex={-1} className="w-full h-full object-contain" draggable={false} />;
  }

  if (status && RENDERING_STATUSES.has(status)) {
    return <RenderingReadout asset={item} />;
  }

  return <RenderPrompt item={item} onRender={onRender} />;
}

function ratioLabel(size: ViewerSize, item: MediaItem): string {
  switch (size) {
    case 'original':
      return item.width && item.height ? `/original ${item.width}x${item.height}` : '/original';
    case 'landscape':
      return '/landscape 1920x1080';
    case 'portrait':
      return '/portrait 1080x1920';
    case 'square':
      return '/square 1080x1080';
  }
}

const ratioIcons: Record<ViewerSize, typeof Monitor> = {
  original: Monitor,
  landscape: Monitor,
  portrait: Smartphone,
  square: Square,
};

function RatioToggle({ active, onSelect, item, renders, status }: {
  active: ViewerSize;
  onSelect: (s: ViewerSize) => void;
  item: MediaItem;
  renders?: string[];
  status?: ClipState;
}) {
  const orientations: Orientation[] = ['landscape', 'portrait', 'square'];
  const clipMode = renders !== undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button tabIndex={-1} className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-bold text-primary/70 hover:text-primary hover:bg-primary/10 transition-colors">
          {ratioLabel(active, item)}
          <ChevronDown className="w-3 h-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {clipMode ? (
          <>
            <DropdownMenuItem onClick={() => onSelect('original')} className="py-2.5">
              <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">
                {active === 'original' ? <Check className="w-3 h-3 inline text-primary" /> : '\u203A'}
              </span>
              <span className={cn('font-mono font-bold text-xs tracking-wider leading-none flex-1', active !== 'original' && 'text-muted-foreground/60')}>
                {ratioLabel('original', item)}
              </span>
              <span className={cn('ml-2 flex items-center', active !== 'original' && 'opacity-40')}>
                <Monitor className="h-3 w-3" />
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {orientations.map((orient) => {
              const Icon = ratioIcons[orient];
              const isActive = active === orient;
              const rendering = isOrientRendering(status, orient);
              return (
                <DropdownMenuItem
                  key={orient}
                  onClick={() => onSelect(orient)}
                  disabled={rendering}
                  className="py-2.5"
                >
                  <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">
                    {isActive ? <Check className="w-3 h-3 inline text-primary" /> : '\u203A'}
                  </span>
                  <span className={cn('font-mono font-bold text-xs tracking-wider leading-none flex-1', !isActive && 'text-muted-foreground/60')}>
                    {ratioLabel(orient, item)}
                  </span>
                  <OrientIndicator orient={orient} renders={renders} status={status} />
                  <span className={cn('ml-1 flex items-center', !isActive && 'opacity-40')}>
                    <Icon className="h-3 w-3" />
                  </span>
                </DropdownMenuItem>
              );
            })}
          </>
        ) : (
          ['original' as ViewerSize, ...orientations].map((size) => {
            const Icon = ratioIcons[size];
            return (
              <DropdownMenuItem key={size} onClick={() => onSelect(size)} className="py-2.5">
                <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">{'\u203A'}</span>
                <span className="font-mono font-bold text-xs tracking-wider leading-none flex-1">{ratioLabel(size, item)}</span>
                <span className="ml-2 opacity-80 flex items-center"><Icon className="h-3 w-3" /></span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const RENDERING_STATUSES = new Set<string>([
  'rendering', 'rendering-landscape', 'rendering-portrait', 'rendering-square',
  'render-queued', 'render-queued-landscape', 'render-queued-portrait', 'render-queued-square',
]);

function isOrientRendering(status: ClipState | undefined, orient: Orientation): boolean {
  if (!status) return false;
  return status === `rendering-${orient}` || status === `render-queued-${orient}`;
}

function OrientIndicator({ orient, renders, status }: {
  orient: Orientation;
  renders: string[];
  status: ClipState | undefined;
}) {
  const isRendered = renders.includes(orient);
  const rendering = isOrientRendering(status, orient);

  if (rendering) {
    return <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />;
  }
  if (isRendered) {
    return <span className="w-1.5 h-1.5 rounded-full bg-primary" />;
  }
  return <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20" />;
}

type BackTab = 'settings' | 'files';

function SettingsPane({ item, renderOrientation, onChangeOrientation, onFlip, onSizeChange, onRender, settings, onSettingsChange }: {
  item: MediaItem;
  renderOrientation: Orientation;
  onChangeOrientation: (orient: Orientation) => void;
  onFlip: (flipped: boolean) => void;
  onSizeChange: (s: ViewerSize) => void;
  onRender?: (settings: RenderSettings) => void;
  settings: RenderSettings;
  onSettingsChange: (s: RenderSettings) => void;
}) {
  const [applyState, setApplyState] = useState<ExecuteButtonState | undefined>(undefined);
  const prevRenderingRef = useRef(false);
  const submittedOrientRef = useRef<Orientation | null>(null);

  const isClip = item.type === 'video' || item.type === 'final';

  const renders = isClip ? (item.renders ?? []) : [];
  const status = isClip ? item.status : undefined;
  const allOrientations: Orientation[] = ['landscape', 'portrait', 'square'];

  const orientationEntries = allOrientations.map((orient) => ({
    orient,
    active: orient === renderOrientation,
    rendered: renders.includes(orient),
    rendering: isOrientRendering(status, orient),
  }));

  const isAnyRendering = orientationEntries.some(o => o.rendering);

  // When rendering finishes, flip card to the rendered orientation
  useEffect(() => {
    const wasRendering = prevRenderingRef.current;
    prevRenderingRef.current = isAnyRendering;

    if (wasRendering && !isAnyRendering && applyState === 'processing') {
      const orient = submittedOrientRef.current ?? renderOrientation;
      submittedOrientRef.current = null;
      const timer = setTimeout(() => {
        setApplyState(undefined);
        onSizeChange(orient);
        onFlip(false);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isAnyRendering, applyState, renderOrientation, onSizeChange, onFlip]);

  // Derive processing state when rendering is detected without a local submit
  const effectiveApplyState = applyState ?? (isAnyRendering ? 'processing' : undefined);
  const controlsDisabled = isAnyRendering || applyState === 'submitting';

  const handleApply = async () => {
    if (!onRender) return;
    submittedOrientRef.current = renderOrientation;
    setApplyState('submitting');
    await onRender(settings);
    setApplyState('processing');
  };

  if (!isClip) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground/50 font-mono">No render settings for this asset type</p>
      </div>
    );
  }

  const handleClick = (orient: Orientation) => {
    const rendering = isOrientRendering(status, orient);
    if (rendering) return;

    onChangeOrientation(orient);

    if (!renders.includes(orient)) {
      onSizeChange(orient);
      onFlip(false);
    }
  };

  const subtitleFieldMap: Record<string, keyof RenderSettings> = {
    enabled: 'subtitlesEnabled',
    style: 'subtitleStyle',
    position: 'subtitlePosition',
    fontSize: 'fontSize',
    textColor: 'textColor',
    highlightColor: 'highlightColor',
  };

  const handleSubtitleChange = (field: string, value: string | boolean) => {
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
    onSettingsChange({ ...settings, [key]: value });
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
      applyState={effectiveApplyState}
      disabled={controlsDisabled}
    />
  );
}

function JsonNode({ data, indent = 0 }: { data: unknown; indent?: number }) {
  const pad = '  '.repeat(indent);
  const bracketClass = 'text-primary/30';
  const punctClass = 'text-zinc-600';

  if (data === null) return <span style={{ color: '#ff4060' }}>null</span>;
  if (typeof data === 'boolean') return <span style={{ color: '#ffcc00' }}>{String(data)}</span>;
  if (typeof data === 'number') return <span style={{ color: '#ff00ff' }}>{data}</span>;
  if (typeof data === 'string') return <span style={{ color: '#39ff14' }}>"{data}"</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className={bracketClass}>[]</span>;
    return (
      <>
        <span className={bracketClass}>[</span>{'\n'}
        {data.map((val, i) => (
          <span key={i}>
            {pad}  <JsonNode data={val} indent={indent + 1} />
            {i < data.length - 1 && <span className={punctClass}>,</span>}
            {'\n'}
          </span>
        ))}
        {pad}<span className={bracketClass}>]</span>
      </>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className={bracketClass}>{'{}'}</span>;
    return (
      <>
        <span className={bracketClass}>{'{'}</span>{'\n'}
        {entries.map(([key, val], i) => (
          <span key={key}>
            {pad}  <span style={{ color: '#00e5ff' }}>"{key}"</span>
            <span className={punctClass}>: </span>
            <JsonNode data={val} indent={indent + 1} />
            {i < entries.length - 1 && <span className={punctClass}>,</span>}
            {'\n'}
          </span>
        ))}
        {pad}<span className={bracketClass}>{'}'}</span>
      </>
    );
  }

  return <span>{String(data)}</span>;
}

function JsonTerminal({ data, loading }: { data: string | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-xs text-muted-foreground/50 font-mono">Loading...</p>
      </div>
    );
  }
  if (data === null) {
    return <p className="text-sm text-muted-foreground/50 font-mono text-center py-8">No data found.</p>;
  }
  if (data.startsWith('Error:')) {
    return <p className="text-sm font-mono" style={{ color: '#ff4060' }}>{data}</p>;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">{data}</pre>;
  }

  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
      <JsonNode data={parsed} />
    </pre>
  );
}

type ManifestFile = { name: string; size_bytes: number; extension: string | null };

const BINARY_EXTENSIONS = new Set(['mp4', 'mp3', 'wav', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'webm', 'mov', 'flac', 'aac', 'ogg']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function isBinaryFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function FileListPane({ files, selectedFile, onSelectFile, loading }: {
  files: ManifestFile[];
  selectedFile: string;
  onSelectFile: (name: string) => void;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }
  return (
    <div className="py-1">
      {files.map((f) => (
        <button
          key={f.name}
          tabIndex={-1}
          onClick={() => onSelectFile(f.name)}
          className={cn(
            'w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 transition-colors',
            selectedFile === f.name
              ? 'bg-primary/10 border-l-2 border-primary text-primary'
              : 'border-l-2 border-transparent hover:bg-white/5',
            f.name.startsWith('.') && selectedFile !== f.name && 'text-muted-foreground/40',
          )}
        >
          <span className="truncate flex-1">{f.name}</span>
          <span className="text-[10px] text-muted-foreground/30 shrink-0">{formatBytes(f.size_bytes)}</span>
        </button>
      ))}
    </div>
  );
}

function FileContentPane({ content, loading, fileName, fileUrl }: {
  content: string | null;
  loading: boolean;
  fileName: string;
  fileUrl: string;
}) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-xs text-muted-foreground/50 font-mono">Loading...</p>
      </div>
    );
  }

  if (isImageFile(fileName)) {
    return (
      <div className="flex items-center justify-center h-full">
        <img src={fileUrl} alt={fileName} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }

  if (isBinaryFile(fileName)) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground/50">
        <p className="text-sm font-mono">Binary file</p>
        <p className="text-xs font-mono">{fileName}</p>
      </div>
    );
  }

  // Text file — use JsonTerminal for .json, plain pre for everything else
  const isJson = fileName.endsWith('.json');
  if (isJson) {
    return <JsonTerminal data={content} loading={false} />;
  }

  if (content === null) {
    return <p className="text-sm text-muted-foreground/50 font-mono text-center py-8">No data found.</p>;
  }

  return (
    <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">{content}</pre>
  );
}

export function AssetViewer({ item, projectSlug, size, onSizeChange, flipped, onFlippedChange, renderOrientation, onChangeOrientation, onRender, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, settings, onSettingsChange }: {
  item: MediaItem;
  projectSlug: string;
  size: ViewerSize;
  onSizeChange: (s: ViewerSize) => void;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
  renderOrientation: Orientation;
  onChangeOrientation: (orient: Orientation) => void;
  onRender?: (settings?: RenderSettings) => void;
  pendingFilePosition?: number | null;
  onClearPendingFilePosition?: () => void;
  pendingBackTab?: BackTab | null;
  onClearPendingBackTab?: () => void;
  settings: RenderSettings;
  onSettingsChange: (s: RenderSettings) => void;
}) {
  useMountKey('viewer');
  const isClip = item.type === 'video' || item.type === 'final';
  const [backTab, setBackTab] = useState<BackTab>('settings');
  const [manifest, setManifest] = useState<ManifestFile[] | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState('.original.json');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const fileUrl = useMemo(
    () => `/files/${projectSlug}/${item.id}/${selectedFile}`,
    [projectSlug, item.id, selectedFile],
  );

  const fetchFileContent = useCallback(async (fileName: string) => {
    if (isBinaryFile(fileName)) {
      setFileContent(null);
      return;
    }
    setFileLoading(true);
    try {
      const res = await fetch(`/files/${projectSlug}/${item.id}/${fileName}`);
      if (res.ok) {
        const text = await res.text();
        // Re-format JSON for pretty display
        if (fileName.endsWith('.json')) {
          try {
            setFileContent(JSON.stringify(JSON.parse(text), null, 2));
          } catch {
            setFileContent(text);
          }
        } else {
          setFileContent(text);
        }
      } else {
        setFileContent(`Error: ${res.status} ${res.statusText}`);
      }
    } catch (e) {
      setFileContent(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFileLoading(false);
    }
  }, [projectSlug, item.id]);

  const fetchManifest = useCallback(async () => {
    setManifestLoading(true);
    try {
      const res = await fetch(`/api/manifest/${projectSlug}/${item.id}`);
      if (res.ok) {
        const data = await res.json();
        setManifest(data.files as ManifestFile[]);
      } else {
        setManifest([]);
      }
    } catch {
      setManifest([]);
    } finally {
      setManifestLoading(false);
    }
  }, [projectSlug, item.id]);

  const pendingFocusRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    onFlippedChange(false);
    setBackTab('settings');
    setManifest(null);
    setSelectedFile('.original.json');
    setFileContent(null);
  }, [item.id, onFlippedChange]);

  // Fetch manifest when files tab is active on the back face
  useEffect(() => {
    if (flipped && backTab === 'files' && manifest === null && !manifestLoading) {
      fetchManifest();
      fetchFileContent('.original.json');
    }
  }, [flipped, backTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply pending focus once manifest loads
  useEffect(() => {
    if (pendingFocusRef.current === undefined || !manifest || manifest.length === 0) return;
    const idx = Math.max(0, Math.min(pendingFocusRef.current - 1, manifest.length - 1));
    const fileName = manifest[idx].name;
    pendingFocusRef.current = undefined;
    setSelectedFile(fileName);
    setFileContent(null);
    fetchFileContent(fileName);
    document.querySelector<HTMLElement>('[data-tabstop="files"]')?.focus();
  }, [manifest, fetchFileContent]);

  const handleFlipToBack = () => {
    setBackTab('settings');
    onFlippedChange(true);
  };

  // Handle pending file position from uiAction dispatch
  useEffect(() => {
    if (pendingFilePosition == null) return;
    pendingFocusRef.current = pendingFilePosition;
    setBackTab('files');
    onFlippedChange(true);
    if (manifest === null) {
      fetchManifest();
    } else {
      const idx = Math.max(0, Math.min(pendingFilePosition - 1, manifest.length - 1));
      const fileName = manifest[idx].name;
      pendingFocusRef.current = undefined;
      setSelectedFile(fileName);
      setFileContent(null);
      fetchFileContent(fileName);
      document.querySelector<HTMLElement>('[data-tabstop="files"]')?.focus();
    }
    onClearPendingFilePosition?.();
  }, [pendingFilePosition]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle pending back tab from uiAction dispatch
  useEffect(() => {
    if (pendingBackTab == null) return;
    setBackTab(pendingBackTab);
    onClearPendingBackTab?.();
  }, [pendingBackTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectFile = useCallback((fileName: string) => {
    setSelectedFile(fileName);
    setFileContent(null);
    fetchFileContent(fileName);
  }, [fetchFileContent]);

  const handleFileKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!manifest || manifest.length === 0) return;
    const idx = manifest.findIndex(f => f.name === selectedFile);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (idx + 1) % manifest.length;
      handleSelectFile(manifest[next].name);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = (idx - 1 + manifest.length) % manifest.length;
      handleSelectFile(manifest[prev].name);
    } else if (e.key === 'Tab') {
      const input = document.querySelector<HTMLElement>('[data-testid="input-chat"]');
      if (input) {
        e.preventDefault();
        input.focus();
      }
    }
  }, [manifest, selectedFile, handleSelectFile]);

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
            {/* Top bar */}
            <div className="shrink-0 px-3 py-2.5 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between relative">
              <RatioToggle
                active={size}
                onSelect={onSizeChange}
                item={item}
                renders={isClip ? (item.renders ?? []) : undefined}
                status={isClip ? item.status : undefined}
              />

              {/* Center slug */}
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="font-mono text-xs font-bold text-muted-foreground truncate max-w-[50%]">{item.slug}</span>
              </span>

              {/* Settings button */}
              <button
                tabIndex={-1}
                onClick={handleFlipToBack}
                title="/settings"
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
              >
                <Settings className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>

            {/* Content */}
            <div className={cn(
              'flex-1 bg-black flex items-center justify-center min-h-0',
              (size === 'portrait' || size === 'square') && 'py-2',
            )}>
              {size === 'portrait' ? (
                <div className="aspect-[9/16] h-full max-w-full">
                  {isClip
                    ? <ClipContent item={item} size={size} onRender={onRender} />
                    : <ImageViewer item={item} size={size} />}
                </div>
              ) : size === 'square' ? (
                <div className="aspect-square h-full max-w-full">
                  {isClip
                    ? <ClipContent item={item} size={size} onRender={onRender} />
                    : <ImageViewer item={item} size={size} />}
                </div>
              ) : (
                isClip
                  ? <ClipContent item={item} size={size} onRender={onRender} />
                  : <ImageViewer item={item} size={size} />
              )}
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            {/* Top bar — matches front */}
            <div className="shrink-0 px-3 py-2 flex items-center justify-between relative" style={{ borderBottom: '1px solid #1F2A36', background: 'rgba(13,15,18,0.8)' }}>
              <div className="inline-flex overflow-hidden" style={{ background: '#0D0F12', border: '1px solid #1F2A36' }}>
                <button
                  tabIndex={-1}
                  onClick={() => setBackTab('settings')}
                  className="h-10 px-3 inline-flex items-center text-[13px] font-mono font-semibold transition-all duration-[160ms]"
                  style={backTab === 'settings'
                    ? { background: 'rgba(0,217,255,0.12)', color: '#00D9FF', boxShadow: '0 0 16px rgba(0,217,255,.35)' }
                    : { color: 'rgba(255,255,255,0.7)' }
                  }
                >
                  /settings
                </button>
                <button
                  tabIndex={-1}
                  onClick={() => setBackTab('files')}
                  className="h-10 px-3 inline-flex items-center text-[13px] font-mono font-semibold transition-all duration-[160ms]"
                  style={backTab === 'files'
                    ? { background: 'rgba(0,217,255,0.12)', color: '#00D9FF', boxShadow: '0 0 16px rgba(0,217,255,.35)' }
                    : { color: 'rgba(255,255,255,0.7)' }
                  }
                >
                  /files
                </button>
              </div>

              <span className="font-mono text-[13px] font-semibold" style={{ color: '#D8E7FF', opacity: 0.6 }}>{item.slug}</span>

              <div
                className="w-6 h-6 flex items-center justify-center text-muted-foreground cursor-pointer"
                onClick={() => onFlippedChange(false)}
              >
                <RotateCcw className="w-4 h-4 stroke-[2.5]" />
              </div>
            </div>

            {/* Back face body */}
            {backTab === 'settings' ? (
              <div className="flex-1 overflow-auto bg-black">
                <SettingsPane
                  item={item}
                  renderOrientation={renderOrientation}
                  onChangeOrientation={onChangeOrientation}
                  onFlip={onFlippedChange}
                  onSizeChange={onSizeChange}
                  onRender={onRender}
                  settings={settings}
                  onSettingsChange={onSettingsChange}
                />
              </div>
            ) : (
              <div className="flex-1 flex min-h-0">
                <div
                  data-tabstop="files"
                  tabIndex={0}
                  onKeyDown={handleFileKeyDown}
                  className="w-[212px] shrink-0 border-r border-zinc-800/60 overflow-y-auto bg-black/40 outline-none focus:ring-1 focus:ring-primary/40"
                >
                  <FileListPane
                    files={manifest ?? []}
                    selectedFile={selectedFile}
                    onSelectFile={handleSelectFile}
                    loading={manifestLoading}
                  />
                </div>
                <div className="flex-1 overflow-auto p-4 bg-black">
                  <FileContentPane
                    content={fileContent}
                    loading={fileLoading}
                    fileName={selectedFile}
                    fileUrl={fileUrl}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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
