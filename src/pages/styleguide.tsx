import { useCallback, useEffect, useRef, useState } from 'react';
import { useWavesurfer } from '@wavesurfer/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { VideoCard } from '@/components/sidebar/cards/VideoCard';
import { FinalVideoCard } from '@/components/sidebar/cards/FinalVideoCard';
import { ImageCard } from '@/components/sidebar/cards/ImageCard';
import { PlanCard } from '@/components/sidebar/cards/PlanCard';
import { ReceivingGhostCard } from '@/components/sidebar/cards/ReceivingGhostCard';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { SelectWithChevron } from '@/components/ui/SelectWithChevron';
import { Toaster } from '@/components/ui/toaster';
import { toast } from '@/hooks/useToast';
import { Input } from '@/components/ui/input';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuCheckboxItem, ContextMenuLabel } from '@/components/ui/context-menu';
import { SlugBadge, DurationBadge, ResolutionBadge } from '@/components/sidebar/cards/badges';
import { JsonSyntax } from '@/components/ui/JsonSyntax';
import { GenToggle } from '@/components/ui/GenToggle';
import { GenField, GenTextarea } from '@/components/ui/GenField';
import { GenSelect } from '@/components/ui/GenSelect';
import { MultiPromptEditor } from '@/components/ui/MultiPromptEditor';
import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import { ChatInput } from '@/components/ui/ChatInput';
import { AssetViewShell, IdleScreen, TransmissionView, TransmissionSequence, RenderingReadout } from '@/components/center-stage';
import { ScriptReadout } from '@/components/chat/ScriptReadout';
import { ProofReadButton } from '@/components/chat/ProofReadButton';
import { ScriptBlock } from '@/components/chat/ScriptBlocks';

import { SidebarHeader } from '@/components/sidebar/SidebarHeader';
import { CollapsibleSidebar } from '@/components/sidebar/CollapsibleSidebar';
import { GenFrame, CloseButton, GenPanel, ExecuteButton, ModelSelector } from '@/components/gen/ui';
import { ImageParamSlots } from '@/components/gen/ImageParamSlots';
import { ElementGroupEditor } from '@/components/gen/ElementGroupEditor';
import { ErrorPage } from '@/components/gen/state/ErrorPage';
import { PendingGenerationsButton } from '@/components/pending-generations/PendingGenerationsButton';
import { PendingGenerationsDrawer } from '@/components/pending-generations/PendingGenerationsDrawer';
import type { GenerationState } from '@/components/pending-generations/PendingGenerationsButton';
import type { ExecuteButtonState, ModelOption, JSONSchemaProperty } from '@/components/gen/types';
import type { MediaItem } from '@/components/sidebar/types';
import {
  FolderOpen, X, ChevronDown, Download, Upload, Sparkles,
  Film, Grid3x3, Scissors, Music, MoreHorizontal, Clapperboard,
  Zap, ImageIcon, Info, Settings, User, LogOut, Bell, Copy, Trash2,
  AlertTriangle, AudioLines, Magnet, Eraser, Minus, Plus,
  Smartphone, Monitor, Square, Play, Volume2, Loader2, Mic,
  Check, CheckCircle2,
} from 'lucide-react';

const colors = [
  { name: 'Primary', bg: 'bg-primary', hex: '#00D4FF' },
  { name: 'Secondary', bg: 'bg-secondary', hex: '#262D3A' },
  { name: 'Accent', bg: 'bg-accent', hex: '#FF9500' },
  { name: 'Destructive', bg: 'bg-destructive', hex: '#EB4747' },
  { name: 'Muted', bg: 'bg-muted', hex: '#1D2233' },
  { name: 'Card', bg: 'bg-card', hex: '#14181F' },
  { name: 'Background', bg: 'bg-background', hex: '#0D0F12' },
  { name: 'Popover', bg: 'bg-popover', hex: '#14181F' },
] as const;


// ── Mock Data ──

const cardOverlayMocks: { item: MediaItem; Component: React.ComponentType<{ item: MediaItem }> }[] = [
  { item: { id: 'o-ready', type: 'video', slug: '@main', title: 'Ready', filePath: '/styleguide-vid-purple-grind.jpg', status: 'ready', durationSeconds: 90, origin: 'wan21', thumbnailSrc: '/styleguide-vid-purple-grind.jpg' }, Component: VideoCard },
  { item: { id: 'o-uploading', type: 'video', slug: '@hero-intro', title: 'Uploading', filePath: '', status: 'uploading', durationSeconds: 30, origin: 'veo3', thumbnailSrc: null }, Component: VideoCard },
  { item: { id: 'o-loading', type: 'video', slug: '@clip', title: 'Loading', filePath: '/styleguide-vid-turret-cyber.jpg', status: 'loading', durationSeconds: 60, origin: 'veo3', thumbnailSrc: '/styleguide-vid-turret-cyber.jpg' }, Component: VideoCard },
  { item: { id: 'o-generating', type: 'image', slug: '@product', title: 'Generating', filePath: '', status: 'generating', width: 1024, height: 1024, origin: 'gpt15_imagen', thumbnailSrc: null }, Component: ImageCard },
  { item: { id: 'o-rendering', type: 'video', slug: '@final-cut', title: 'Rendering', filePath: '', status: 'rendering', durationSeconds: 120, origin: 'veo3', thumbnailSrc: '/styleguide-vid-sky-ghost.jpg' }, Component: VideoCard },
  { item: { id: 'o-downloading', type: 'image', slug: '@bg', title: 'Downloading', filePath: '', status: 'downloading', width: 3840, height: 2160, origin: 'nano_banana', thumbnailSrc: null }, Component: ImageCard },
  { item: { id: 'o-untranscribed', type: 'video', slug: '@interview', title: 'Untranscribed', filePath: '/styleguide-vid-purple-grind.jpg', status: 'untranscribed', durationSeconds: 120, origin: 'veo3', thumbnailSrc: '/styleguide-vid-purple-grind.jpg' }, Component: VideoCard },
  { item: { id: 'o-transcribing', type: 'video', slug: '@interview-final', title: 'Transcribing', filePath: '/styleguide-vid-turret-cyber.jpg', status: 'transcribing', durationSeconds: 120, origin: 'veo3', thumbnailSrc: '/styleguide-vid-turret-cyber.jpg' }, Component: VideoCard },
  { item: { id: 'o-corrupt', type: 'video', slug: '@glitched', title: 'Corrupt', filePath: '', status: 'corrupt', durationSeconds: 45, origin: 'veo3', thumbnailSrc: null }, Component: VideoCard },
  { item: { id: 'o-error', type: 'video', slug: '@broken-clip', title: 'Error', filePath: '', status: 'error', durationSeconds: 30, origin: 'veo3', thumbnailSrc: null }, Component: VideoCard },
  { item: { id: 'o-elf', type: 'final', slug: '@final', title: 'Elf Building', filePath: '', status: 'rendering', durationSeconds: 180, thumbnailSrc: '/styleguide-final-thumb.jpg' }, Component: FinalVideoCard },
  { item: { id: 'o-final-ready', type: 'final', slug: '@final-export-v2', title: 'Final Ready', filePath: '/final.mp4', status: 'ready', durationSeconds: 180, thumbnailSrc: '/styleguide-final-thumb.jpg' }, Component: FinalVideoCard },
];

// ── Helper Components ──

function StyleguideWaveform({
  url,
  height,
  waveColor = 'rgba(0, 255, 255, 0.3)',
  progressColor = 'rgba(0, 255, 255, 0.8)',
  progress = 0,
}: {
  url: string;
  height: number;
  waveColor?: string;
  progressColor?: string;
  progress?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { wavesurfer } = useWavesurfer({
    container: containerRef,
    height,
    waveColor,
    progressColor,
    url,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    interact: false,
    normalize: true,
  });

  useEffect(() => {
    if (!wavesurfer || progress <= 0) return;
    const handleReady = () => wavesurfer.seekTo(progress);
    wavesurfer.on('ready', handleReady);
    return () => { wavesurfer.un('ready', handleReady); };
  }, [wavesurfer, progress]);

  return <div ref={containerRef} className="w-full" />;
}

// ── App Layout Demo Helpers ──

function BracketLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-bold tracking-[0.15em] text-primary/70 uppercase">[{label}]</span>
      {required && <span className="text-[8px] font-bold text-red-400/80 tracking-wider">*REQ</span>}
    </div>
  );
}

function ToggleGroup({ options, activeIndex }: { options: string[]; activeIndex: number }) {
  return (
    <div className="inline-flex border border-primary/30 rounded overflow-hidden bg-black/40">
      {options.map((opt, i) => (
        <button
          key={opt}
          type="button"
          className={[
            'font-mono font-bold tracking-wider px-4 h-9 text-xs',
            i > 0 ? 'border-l border-primary/30' : '',
            i === activeIndex
              ? 'bg-primary/20 text-primary shadow-[inset_0_0_12px_rgba(0,255,255,0.3)]'
              : 'text-primary/50',
          ].join(' ')}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function FakeDropdown({ text }: { text: string }) {
  return (
    <div className="bg-black/60 border border-primary/30 rounded px-3 py-2.5 text-xs font-mono font-bold tracking-wide text-primary/90 flex items-center gap-2">
      {text}
      <ChevronDown className="w-3 h-3 text-primary/50" />
    </div>
  );
}

function TimelineSlotDemo({
  label,
  isActive = false,
  isDragOver = false,
  hasContent = false,
  thumbnailSrc,
  assetId,
  flex = 1,
}: {
  label: string;
  isActive?: boolean;
  isDragOver?: boolean;
  hasContent?: boolean;
  thumbnailSrc?: string;
  assetId?: string;
  flex?: number;
}) {
  return (
    <div
      className={cn(
        'relative h-full border bg-card/30 backdrop-blur-sm flex flex-col cursor-pointer transition-all duration-150 group overflow-hidden',
        isDragOver
          ? 'border-2 border-dashed border-primary bg-primary/10 scale-y-[1.02] shadow-[0_0_15px_rgba(0,255,255,0.3)]'
          : isActive
            ? 'border-primary bg-primary/5'
            : 'border-border/50 hover:border-primary/30',
        hasContent && !isDragOver && 'cursor-grab active:cursor-grabbing'
      )}
      style={{ flex: `${flex} 1 0`, minWidth: '60px' }}
    >
      {/* Slot label badge */}
      <div className="absolute top-1.5 left-1.5 z-30">
        <span className="text-[10px] font-mono text-primary font-bold px-1.5 py-0.5 rounded bg-black/80 backdrop-blur-md border border-primary/15 whitespace-nowrap tracking-wide">
          {label}
        </span>
      </div>

      {/* Context menu button */}
      <div className="absolute top-1.5 right-1.5 z-30">
        <button className="w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-primary transition-colors duration-150 rounded hover:bg-black/40">
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content */}
      {hasContent ? (
        <div className="absolute inset-0 w-full h-full">
          <div className="absolute inset-0 bg-primary/5" />
          {thumbnailSrc && (
            <img src={thumbnailSrc} draggable={false} className="w-full h-full object-cover opacity-50" alt="" />
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center opacity-15 group-hover:opacity-35 transition-opacity duration-200">
          <div className="w-7 h-7 border border-dashed border-foreground/60 rounded-full flex items-center justify-center">
            <span className="text-[10px] text-foreground/60">+</span>
          </div>
        </div>
      )}

      {/* Asset ID label */}
      {assetId && (
        <div className="absolute bottom-1.5 left-1.5 z-20 max-w-[calc(100%-12px)]">
          <span className="text-[9px] font-mono text-muted-foreground/60 px-1 py-0.5 rounded bg-black/70 truncate block leading-tight">
            {assetId}
          </span>
        </div>
      )}

      {/* Active Indicator */}
      {isActive && (
        <div className="absolute bottom-0 inset-x-0 h-0.5 bg-primary shadow-[0_0_10px_var(--color-primary)]" />
      )}
    </div>
  );
}

const demoImageMock: MediaItem = {
  id: 'demo-image-ready', type: 'image', slug: '@img-neon-fox', title: 'Neon Fox', filePath: '/styleguide-img-neon-fox.jpg',
  status: 'ready', width: 1920, height: 1080, origin: 'nano_banana', thumbnailSrc: '/styleguide-img-neon-fox.jpg',
};

const demoVideoMock: MediaItem = {
  id: 'demo-video-ready', type: 'video', slug: '@vid-purple-grind', title: 'Purple Grind', filePath: '/styleguide-vid-purple-grind.jpg',
  status: 'ready', durationSeconds: 90, origin: 'wan21', thumbnailSrc: '/styleguide-vid-purple-grind.jpg',
};

function HeaderBar() {
  return (
    <div className="bg-card border-b border-border flex items-center justify-between px-2 h-12">
      <div className="flex items-center gap-1">
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 h-full">
          <div className="w-2.5 h-2.5 rounded-full bg-primary shrink-0 logo-dot-pulse" />
          <span className="font-mono font-bold text-sm uppercase tracking-wider"><span className="text-foreground">CLIP</span><span className="text-primary">FIRST</span></span>
        </div>

        {/* Project selector */}
        <button className="flex items-center gap-1.5 px-4 py-1.5 rounded border border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors font-mono text-sm">
          <FolderOpen className="w-3.5 h-3.5 shrink-0" />
          <span>vax</span>
          <ChevronDown className="w-3 h-3 opacity-50" />
        </button>

        {/* Divider */}
        <div className="w-px h-5 bg-border mx-1" />

        {/* Generations */}
        <button className="flex items-center gap-1.5 px-4 py-1.5 rounded border border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors font-mono text-xs uppercase tracking-wider">
          <Clapperboard className="w-3.5 h-3.5 shrink-0" />
          <span>Generations</span>
        </button>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1">
        <button className="flex items-center gap-1.5 px-5 py-1.5 rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors font-mono text-xs font-bold uppercase tracking-wider">
          <Scissors className="w-3.5 h-3.5 shrink-0" />
          <span>Clip It</span>
        </button>
      </div>
    </div>
  );
}

function AppLayoutDemo() {
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftSort, setLeftSort] = useState<'newest' | 'oldest'>('newest');
  const [rightSort, setRightSort] = useState<'newest' | 'oldest'>('newest');

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-mono font-bold mb-2 text-blue-400">App Layout</h2>
        <p className="text-xs font-mono text-muted-foreground mb-6">
          Full application frame — header, collapsible sidebars, center stage, and timeline. The establishing shot.
        </p>
      </div>
      <div className="overflow-x-auto">
      <div className="min-w-[1100px] overflow-hidden rounded-lg border border-border/60 bg-background shadow-[0_0_40px_-12px_rgba(0,212,255,0.08)]">
        <div className="grid grid-rows-[48px_1fr_auto] h-[800px]">
          {/* ── Nav Bar ── */}
          <HeaderBar />

          {/* ── Middle Row: sidebars + center ── */}
          <div className="flex flex-row overflow-hidden">
            {/* Left Sidebar */}
            <CollapsibleSidebar side="left" collapsed={!leftOpen} onToggle={() => setLeftOpen((o) => !o)} expandedWidth="210px" collapsedWidth="40px" padding="px-2 pt-2 pb-2" gap="gap-0">
              <SidebarHeader icon={<Grid3x3 className="w-3.5 h-3.5" />} title="Assets" collapsed={!leftOpen} onToggle={() => setLeftOpen((o) => !o)} side="left" sortOrder={leftSort} onSortChange={() => setLeftSort((s) => s === 'newest' ? 'oldest' : 'newest')} />
              {leftOpen && (
                <>
                  <div className="flex-1 overflow-y-auto space-y-2">
                    <div className="w-full"><ImageCard item={demoImageMock} /></div>
                  </div>
                  <div className="pt-2 mt-auto">
                    <Button variant="dashed" className="w-full" size="sm">
                      <Upload className="w-3.5 h-3.5" />
                      UPLOAD_ASSET
                    </Button>
                  </div>
                </>
              )}
            </CollapsibleSidebar>

            {/* Center Content */}
            <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 p-4 overflow-y-auto flex flex-col">
              {/* VIDEO_GENERATION Panel — DynamicGen Style */}
              <div className="relative w-full flex-1 overflow-hidden bg-gradient-to-b from-cyan-950/30 via-black to-black rounded flex flex-col">
                {/* Scanlines overlay */}
                <div className="absolute inset-0 pointer-events-none scanlines opacity-20 z-10" />
                {/* Pixel grid background */}
                <div
                  className="absolute inset-0 pointer-events-none opacity-5"
                  style={{
                    backgroundImage:
                      'linear-gradient(rgba(0, 255, 255, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 255, 0.1) 1px, transparent 1px)',
                    backgroundSize: '4px 4px',
                  }}
                />

                {/* Inner bordered frame */}
                <div className="relative z-20 flex-1 flex flex-col border-2 border-cyan-400/50 shadow-[0_0_30px_-10px_rgba(0,255,255,0.3)]">
                  {/* Header */}
                  <div className="flex items-center justify-between pl-2.5 pr-2.5 py-1.5 shrink-0 border-b-2 border-inherit bg-black/50 backdrop-blur-sm">
                    <div className="flex items-center gap-2">
                      <Film className="w-4 h-4 text-cyan-400 drop-shadow-[0_0_6px_#22d3ee]" />
                      <span className="text-xs font-bold tracking-[0.15em] text-cyan-400">VIDEO_GENERATION</span>
                    </div>
                    <button className="w-7 h-7 flex items-center justify-center text-primary/60 transition-all hover:bg-red-500/10 hover:text-red-400">
                      <X className="w-5 h-5 stroke-[2.5]" />
                    </button>
                  </div>

                  {/* Body: form + asset sidebar */}
                  <div className="flex flex-row flex-1">
                    {/* Form column */}
                    <div className="flex-1 pl-4 pr-8 py-4 mr-2">
                      {/* [PROMPT] section */}
                      <div className="space-y-2 mb-3">
                        <div className="flex items-center justify-between">
                          <BracketLabel label="PROMPT" required />
                          <button className="inline-flex items-center gap-1 h-5 px-1.5 text-[10px] font-mono font-bold tracking-wider text-primary bg-primary/20 border border-primary/40 rounded shadow-[0_0_8px_rgba(0,255,255,0.3)]">
                            <Sparkles className="w-3 h-3" />
                            Rewrite
                          </button>
                        </div>
                        <textarea
                          className="w-full px-3 py-2 resize-none bg-black/60 border border-primary/30 rounded text-primary/90 font-mono text-xs leading-relaxed focus:outline-none focus:border-primary/60 shadow-[inset_0_0_15px_rgba(0,255,255,0.1)] h-28"
                          defaultValue="Create a dynamic and engaging video showcasing a variety of scenes and scenarios, highlighting vibrant visuals and motion."
                          readOnly
                        />
                      </div>

                      {/* Parameters */}
                      <div className="flex flex-wrap gap-x-6 gap-y-4 my-3">
                        <div>
                          <BracketLabel label="ASPECT RATIO" />
                          <div className="mt-1.5">
                            <ToggleGroup options={['16:9', '9:16', '1:1']} activeIndex={0} />
                          </div>
                        </div>
                        <div>
                          <BracketLabel label="DURATION" />
                          <div className="mt-1.5">
                            <FakeDropdown text="8" />
                          </div>
                        </div>
                        <div>
                          <BracketLabel label="IMAGE ORIENTATION" />
                          <div className="mt-1.5">
                            <ToggleGroup options={['auto', 'original', 'portrait', 'landscape']} activeIndex={0} />
                          </div>
                        </div>
                        <div>
                          <BracketLabel label="MODE" />
                          <div className="mt-1.5">
                            <ToggleGroup options={['std', 'pro']} activeIndex={0} />
                          </div>
                        </div>
                        <div>
                          <BracketLabel label="MULTI SHOTS" />
                          <div className="mt-1.5">
                            <ToggleGroup options={['No', 'Yes']} activeIndex={0} />
                          </div>
                        </div>
                        <div>
                          <BracketLabel label="SOUND" />
                          <div className="mt-1.5">
                            <ToggleGroup options={['No', 'Yes']} activeIndex={1} />
                          </div>
                        </div>
                      </div>

                      {/* Warnings */}
                      <div className="mt-3 border border-yellow-500/30 bg-yellow-500/5 rounded p-3">
                        <div className="text-xs font-mono font-bold text-yellow-400/70 uppercase tracking-wider mb-1">WARNINGS</div>
                        <ul className="list-disc list-inside">
                          <li className="text-xs font-mono text-yellow-400/70">Kling 3.0 multi_prompt must be a non-empty list</li>
                        </ul>
                      </div>
                    </div>

                    {/* Asset sidebar */}
                    <div className="w-44 border-l border-primary/20 bg-black/20 p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <BracketLabel label="IMAGES" />
                        <span className="text-[10px] font-mono text-primary/50">1/2</span>
                      </div>

                      {/* Filled slot */}
                      <div className="relative aspect-video border-2 border-primary/50 bg-black/60 overflow-hidden">
                        <div className="absolute inset-0 scanlines pointer-events-none opacity-20" />
                        <img src="/styleguide-img-cover.jpg" alt="thumbnail" className="w-full h-full object-cover" />
                        <button className="absolute top-1 right-1 w-5 h-5 rounded bg-black/70 border border-primary/30 flex items-center justify-center hover:bg-red-500/30 hover:border-red-500/60 transition-colors">
                          <X className="w-3 h-3 text-primary/70" />
                        </button>
                      </div>

                      {/* Empty slot */}
                      <div className="relative aspect-video border-2 border-primary/30 border-dashed bg-black/60 overflow-hidden flex items-center justify-center">
                        <div className="absolute inset-0 scanlines pointer-events-none opacity-20" />
                        <ImageIcon className="w-5 h-5 text-primary/25 relative z-10" />
                        <div className="absolute inset-0 pointer-events-none showcase-slot-ready" />
                      </div>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="shrink-0 p-2.5 border-t-2 border-inherit bg-black/30 flex items-center justify-between">
                    <FakeDropdown text="Kling 3.0" />
                    <button className="relative w-48 py-3 px-6 overflow-hidden font-bold text-sm tracking-[0.2em] uppercase border-2 rounded transition-all duration-300 bg-cyan-500/20 text-cyan-400 border-current shadow-[0_0_20px_rgba(34,211,238,0.5)] hover:bg-cyan-500/30 hover:scale-[1.02] active:scale-[0.98]">
                      <div className="relative flex items-center justify-center gap-2">
                        <Zap className="w-5 h-5 drop-shadow-[0_0_6px_currentColor]" />
                        <span>GENERATE</span>
                      </div>
                      {/* Pulsing glow overlay */}
                      <div
                        className="absolute inset-0 pointer-events-none rounded"
                        style={{
                          boxShadow: 'inset 0 0 15px rgba(34,211,238,0.5)',
                          animation: 'showcase-slot-pulse 2s ease-in-out infinite',
                        }}
                      />
                    </button>
                  </div>
                </div>
              </div>

            </div>
              {/* Chat input — sticky bottom */}
              <div className="shrink-0 px-4 pb-3 pt-2">
                <ChatInput assetSlugs={['@hero-intro', '@product-shot', '@bg-neon', '@outro-final', '@clip-dance']} />
              </div>
            </div>

            {/* Right Sidebar */}
            <CollapsibleSidebar side="right" collapsed={!rightOpen} onToggle={() => setRightOpen((o) => !o)} expandedWidth="210px" collapsedWidth="40px" padding="px-2 pt-2 pb-2" gap="gap-0">
              <SidebarHeader icon={<Grid3x3 className="w-3.5 h-3.5" />} title="Clips" collapsed={!rightOpen} onToggle={() => setRightOpen((o) => !o)} side="right" sortOrder={rightSort} onSortChange={() => setRightSort((s) => s === 'newest' ? 'oldest' : 'newest')} />
              {rightOpen && (
                <>
                  <div className="flex-1 overflow-y-auto space-y-2 mt-2">
                    <div className="w-full"><VideoCard item={demoVideoMock} /></div>
                  </div>
                  <div className="pt-2 mt-auto">
                    <Button variant="dashed" className="w-full" size="sm">
                      <Upload className="w-3.5 h-3.5" />
                      UPLOAD_CLIP
                    </Button>
                  </div>
                </>
              )}
            </CollapsibleSidebar>
          </div>

          {/* ── Bottom Timeline ── */}
          <div className="border-t border-border bg-card/30">
            <div className="relative h-28 flex gap-0.5">
              <TimelineSlotDemo label="@s01" hasContent thumbnailSrc="/styleguide-vid-purple-grind.jpg" assetId="vid-purple-grind" flex={3} />
              <TimelineSlotDemo label="@s02" hasContent thumbnailSrc="/styleguide-img-neon-fox.jpg" assetId="vid-neon-fox" isActive flex={2} />
              <TimelineSlotDemo label="@s03" hasContent thumbnailSrc="/styleguide-vid-sky-ghost.jpg" assetId="vid-sky-ghost" flex={3} />
              <TimelineSlotDemo label="@s04" flex={2} />
              <TimelineSlotDemo label="@s05" flex={2} />
              {/* Playhead */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-primary z-[100] pointer-events-none shadow-[0_0_8px_var(--color-primary)]"
                style={{ left: '42%' }}
              />
            </div>
            <div className="border-2 border-dashed rounded flex items-center justify-center gap-2 transition-colors h-14 min-h-14 border-border/40 text-muted-foreground/50">
              <Music className="w-3.5 h-3.5" />
              <span className="font-mono text-xs">DROP_AUDIO_TRACK</span>
            </div>
          </div>
        </div>
      </div>
      </div>
    </section>
  );
}

function SelectWithChevronDemo() {
  const [value, setValue] = useState('veo3');
  return (
    <SelectWithChevron value={value} onChange={setValue}>
      <option value="veo3">Veo 3</option>
      <option value="kling3">Kling 3.0</option>
      <option value="wan21">Wan 2.1</option>
      <option value="sora">Sora</option>
    </SelectWithChevron>
  );
}

// ── Stateful Demo Helpers for Batch 2 ──

function GenToggleDemo() {
  const [aspect, setAspect] = useState<string>('16:9');
  const [mode, setMode] = useState<string>('std');
  const [compactVal, setCompactVal] = useState<string>('5');
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-[11px] font-mono text-muted-foreground/70">Standard</p>
        <GenToggle value={aspect} onChange={setAspect} options={['16:9', '9:16', '1:1']} />
      </div>
      <div className="space-y-1.5">
        <p className="text-[11px] font-mono text-muted-foreground/70">Two options</p>
        <GenToggle value={mode} onChange={setMode} options={['std', 'pro']} />
      </div>
      <div className="space-y-1.5">
        <p className="text-[11px] font-mono text-muted-foreground/70">Compact</p>
        <GenToggle value={compactVal} onChange={setCompactVal} options={['3', '5', '8', '10']} compact />
      </div>
      <div className="space-y-1.5">
        <p className="text-[11px] font-mono text-muted-foreground/70">Disabled</p>
        <GenToggle value="std" onChange={() => {}} options={['std', 'pro']} disabled />
      </div>
    </div>
  );
}

function GenFieldDemo() {
  const [text, setText] = useState('A cinematic shot of a neon-lit cityscape at night');
  return (
    <div className="space-y-4">
      <GenField label="PROMPT" required>
        <GenTextarea value={text} onChange={setText} placeholder="Describe your scene..." rows={3} />
      </GenField>
      <GenField label="NEGATIVE PROMPT" actions={<span className="text-[10px] font-mono text-primary/40">optional</span>}>
        <GenTextarea value="" onChange={() => {}} placeholder="What to avoid..." rows={2} />
      </GenField>
      <GenField label="DISABLED FIELD">
        <GenTextarea value="This field is disabled" onChange={() => {}} disabled />
      </GenField>
    </div>
  );
}

function GenSelectDemo() {
  const [value, setValue] = useState('kling3');
  return (
    <div className="w-[240px]">
      <GenSelect
        value={value}
        onChange={setValue}
        options={[
          { value: 'veo3', label: 'Veo 3' },
          { value: 'kling3', label: 'Kling 3.0' },
          { value: 'wan21', label: 'Wan 2.1' },
          { value: 'sora', label: 'Sora' },
        ]}
      />
    </div>
  );
}

function MultiPromptEditorDemo() {
  const [scenes, setScenes] = useState([
    { prompt: 'Wide establishing shot of the city skyline at golden hour', duration: 5 },
    { prompt: 'Close-up of hands typing on a laptop', duration: 3 },
  ]);
  return (
    <div>
      <MultiPromptEditor value={scenes} onChange={setScenes} />
    </div>
  );
}

function AssetDropSlotDemo() {
  const [filled, setFilled] = useState<{ slug: string; src: string; thumbnailSrc?: string | null; type: 'image' | 'video' } | null>({
    slug: '@hero-bg',
    src: '/styleguide-img-cover.jpg',
    thumbnailSrc: '/styleguide-img-cover.jpg',
    type: 'image',
  });
  const [empty, setEmpty] = useState<{ slug: string; src: string; thumbnailSrc?: string | null; type: 'image' | 'video' } | null>(null);
  return (
    <div className="flex flex-wrap gap-5">
      <div className="w-[180px] space-y-1.5">
        <p className="text-[11px] font-mono text-muted-foreground/70">With value (image)</p>
        <AssetDropSlot value={filled} onChange={setFilled} />
      </div>
      <div className="w-[180px] space-y-1.5">
        <p className="text-[11px] font-mono text-muted-foreground/70">Empty (image)</p>
        <AssetDropSlot value={empty} onChange={setEmpty} />
      </div>
      <div className="w-[180px] space-y-1.5">
        <p className="text-[11px] font-mono text-muted-foreground/70">Empty (video)</p>
        <AssetDropSlot value={null} onChange={() => {}} acceptTypes={['video']} />
      </div>
      <div className="w-[180px] space-y-1.5">
        <p className="text-[11px] font-mono text-muted-foreground/70">Disabled</p>
        <AssetDropSlot value={null} onChange={() => {}} disabled />
      </div>
    </div>
  );
}

function ContextMenuDemo() {
  const [showGrid, setShowGrid] = useState(true);
  const [showGuides, setShowGuides] = useState(false);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="w-full h-[88px] rounded-lg border border-dashed border-primary/25 bg-card/60 flex items-center justify-center cursor-context-menu select-none">
          <span className="text-[11px] font-mono text-muted-foreground/60">Right-click this area</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>Edit</ContextMenuLabel>
        <ContextMenuItem><Copy className="w-3.5 h-3.5 mr-2" /> Copy</ContextMenuItem>
        <ContextMenuItem><Download className="w-3.5 h-3.5 mr-2" /> Download</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuLabel>View</ContextMenuLabel>
        <ContextMenuCheckboxItem checked={showGrid} onCheckedChange={setShowGrid}>Show Grid</ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem checked={showGuides} onCheckedChange={setShowGuides}>Show Guides</ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive"><Trash2 className="w-3.5 h-3.5 mr-2" /> Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const allExecuteStates: ExecuteButtonState[] = ['disabled', 'ready', 'charging', 'submitting', 'queued', 'processing', 'success'];

function ExecuteButtonStatesDemo() {
  return (
    <div className="space-y-2.5">
      {allExecuteStates.map((state) => (
        <div key={state} className="flex items-center gap-4">
          <span className="text-[11px] font-mono text-muted-foreground/70 w-24 shrink-0">{state}</span>
          <div className="flex-1 max-w-[240px]">
            <ExecuteButton state={state} onClick={() => {}} disabledReason="Fill required fields" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── CenterStage: TransmissionView ──

const centerStageMocks = [
  { id: 'cs-transmission', label: 'transmission', message: 'Generate a 30s product demo with upbeat music' },
  { id: 'cs-transmission-short', label: 'transmission (short)', message: 'Retry render' },
];

function CenterStageSection() {
  const [replayCount, setReplayCount] = useState(0);
  const handleComplete = useCallback(() => setReplayCount((n) => n + 1), []);

  return (
    <section className="mb-20 rounded-2xl bg-gradient-to-b from-cyan-950/20 via-background to-background p-8 ring-1 ring-cyan-500/10 shadow-[0_0_60px_-15px_rgba(0,212,255,0.12)]">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-1.5 h-8 rounded-full bg-cyan-500 shadow-[0_0_12px_rgba(0,212,255,0.5)]" />
        <h2 className="text-2xl font-mono font-bold text-cyan-400 tracking-wide">CenterStage: TransmissionView</h2>
      </div>
      <p className="text-xs font-mono text-cyan-300/50 mb-10 pl-5">
        Animated transition shown when a new message is sent. Phases: flash scan line, typewriter text, dissolve.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
        {centerStageMocks.map((mock) => (
          <div key={`${mock.id}-${replayCount}`} className="flex flex-col gap-4">
            <span className="text-[11px] font-mono text-cyan-400/70 uppercase tracking-[0.2em] bg-cyan-500/10 px-3 py-1 rounded-full w-fit">{mock.label}</span>
            <div className="h-[340px] bg-black/60 rounded-xl overflow-hidden flex flex-col border border-cyan-500/20 shadow-[0_0_40px_-10px_rgba(0,212,255,0.15),inset_0_1px_0_rgba(0,212,255,0.1)] ring-1 ring-cyan-500/20">
              <TransmissionView message={mock.message} onComplete={handleComplete} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── CenterStage: IdleScreen ──

function IdleScreenSection() {
  return (
    <section className="mb-20 rounded-2xl bg-gradient-to-b from-cyan-950/20 via-background to-background p-8 ring-1 ring-cyan-500/10 shadow-[0_0_60px_-15px_rgba(0,212,255,0.12)]">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-1.5 h-8 rounded-full bg-cyan-500 shadow-[0_0_12px_rgba(0,212,255,0.5)]" />
        <h2 className="text-2xl font-mono font-bold text-cyan-400 tracking-wide">CenterStage: IdleScreen</h2>
      </div>
      <p className="text-xs font-mono text-cyan-300/50 mb-10 pl-5">
        Pulsing idle state shown when no asset is selected. Badge appears in welcome mode.
      </p>
      <div className="max-w-2xl flex flex-col gap-4">
        <span className="text-[11px] font-mono text-cyan-400/70 uppercase tracking-[0.2em] bg-cyan-500/10 px-3 py-1 rounded-full w-fit">welcome</span>
        <div className="h-[360px] bg-black/60 rounded-xl overflow-hidden flex border border-cyan-500/20 shadow-[0_0_40px_-10px_rgba(0,212,255,0.15),inset_0_1px_0_rgba(0,212,255,0.1)] ring-1 ring-cyan-500/20">
          <IdleScreen label="WAITING_FOR_INPUT..." badge="SRC: NULL" />
        </div>
      </div>
    </section>
  );
}

// ── CenterStage: AssetViewShell ──

const assetViewShellMocks = [
  { id: 'shell-constrained', label: 'constrained (fillParent=false)', fillParent: false },
  { id: 'shell-full', label: 'full bleed (fillParent=true)', fillParent: true },
];

function AssetViewShellSection() {
  return (
    <section className="mb-20 rounded-2xl bg-gradient-to-b from-cyan-950/20 via-background to-background p-8 ring-1 ring-cyan-500/10 shadow-[0_0_60px_-15px_rgba(0,212,255,0.12)]">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-1.5 h-8 rounded-full bg-cyan-500 shadow-[0_0_12px_rgba(0,212,255,0.5)]" />
        <h2 className="text-2xl font-mono font-bold text-cyan-400 tracking-wide">CenterStage: AssetViewShell</h2>
      </div>
      <p className="text-xs font-mono text-cyan-300/50 mb-10 pl-5">
        Shared frame for all asset-mode views. Two modes: constrained (max-w-4xl, aspect-video) and full bleed (w-full
        h-full). Border + shadow provide consistent visual containment.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
        {assetViewShellMocks.map((mock) => (
          <div key={mock.id} className="flex flex-col gap-4">
            <span className="text-[11px] font-mono text-cyan-400/70 uppercase tracking-[0.2em] bg-cyan-500/10 px-3 py-1 rounded-full w-fit">{mock.label}</span>
            <div className="h-[300px] bg-black/60 rounded-xl overflow-hidden flex border border-cyan-500/20 shadow-[0_0_40px_-10px_rgba(0,212,255,0.15),inset_0_1px_0_rgba(0,212,255,0.1)] ring-1 ring-cyan-500/20">
              <AssetViewShell fillParent={mock.fillParent}>
                <div className="flex items-center justify-center w-full h-full">
                  <span className="font-mono text-xs text-cyan-500/40 tracking-widest">CONTENT_AREA</span>
                </div>
              </AssetViewShell>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── CenterStage: RenderingReadout ──

const renderingReadoutMocks: { id: string; label: string; asset: MediaItem }[] = [
  {
    id: 'readout-rendering',
    label: 'rendering (video)',
    asset: {
      id: 'vid-hero',
      type: 'video',
      slug: '@hero-intro',
      title: 'Hero Intro',
      filePath: '',
      status: 'rendering',
      durationSeconds: 30,
    },
  },
  {
    id: 'readout-landscape',
    label: 'rendering-landscape',
    asset: {
      id: 'vid-wide',
      type: 'video',
      slug: '@wide-shot-establishing',
      title: 'Wide Shot',
      filePath: '',
      status: 'rendering-landscape',
      durationSeconds: 60,
    },
  },
  {
    id: 'readout-portrait',
    label: 'rendering-portrait',
    asset: {
      id: 'vid-tall',
      type: 'video',
      slug: '@portrait-reel',
      title: 'Portrait Reel',
      filePath: '',
      status: 'rendering-portrait',
      durationSeconds: 45,
    },
  },
  {
    id: 'readout-final',
    label: 'rendering (final)',
    asset: {
      id: 'vid-final',
      type: 'final',
      slug: '@final-export-v2',
      title: 'Final',
      filePath: '',
      status: 'rendering',
      durationSeconds: 180,
    },
  },
  {
    id: 'readout-queued',
    label: 'render-queued',
    asset: {
      id: 'vid-queued',
      type: 'video',
      slug: '@queued-clip',
      title: 'Queued Clip',
      filePath: '',
      status: 'render-queued',
      durationSeconds: 30,
    },
  },
  {
    id: 'readout-queued-final',
    label: 'render-queued (final)',
    asset: {
      id: 'vid-queued-final',
      type: 'final',
      slug: '@final-queued',
      title: 'Final Queued',
      filePath: '',
      status: 'render-queued',
      durationSeconds: 120,
    },
  },
];

function RenderingReadoutSection() {
  return (
    <section className="mb-20 rounded-2xl bg-gradient-to-b from-cyan-950/20 via-background to-background p-8 ring-1 ring-cyan-500/10 shadow-[0_0_60px_-15px_rgba(0,212,255,0.12)]">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-1.5 h-8 rounded-full bg-cyan-500 shadow-[0_0_12px_rgba(0,212,255,0.5)]" />
        <h2 className="text-2xl font-mono font-bold text-cyan-400 tracking-wide">CenterStage: RenderingReadout</h2>
      </div>
      <p className="text-xs font-mono text-cyan-300/50 mb-10 pl-5">
        Full-panel rendering status view shown in center stage when a video asset is rendering. Scan line animation,
        grid overlay, corner HUD brackets, Film/Clapperboard icon (type-aware), pulsing status badge, and slug text.
        Cyan for regular videos, amber for final-type assets.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-10">
        {renderingReadoutMocks.map((mock) => (
          <div key={mock.id} className="flex flex-col gap-4">
            <span className="text-[11px] font-mono text-cyan-400/70 uppercase tracking-[0.2em] bg-cyan-500/10 px-3 py-1 rounded-full w-fit">{mock.label}</span>
            <div className="h-[240px] bg-black/60 rounded-xl overflow-hidden border border-cyan-500/20 shadow-[0_0_40px_-10px_rgba(0,212,255,0.15),inset_0_1px_0_rgba(0,212,255,0.1)] ring-1 ring-cyan-500/20">
              <RenderingReadout asset={mock.asset} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── CenterStage: FailedAssetReadout (static replica) ──

function FailedAssetReadoutSection() {
  return (
    <section className="mb-20 rounded-2xl bg-gradient-to-b from-red-950/20 via-background to-background p-8 ring-1 ring-red-500/10 shadow-[0_0_60px_-15px_rgba(255,50,50,0.10)]">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-1.5 h-8 rounded-full bg-red-500 shadow-[0_0_12px_rgba(255,50,50,0.5)]" />
        <h2 className="text-2xl font-mono font-bold text-red-400 tracking-wide">CenterStage: FailedAssetReadout</h2>
      </div>
      <p className="text-xs font-mono text-red-300/40 mb-10 pl-5">
        Error diagnostic panel shown in center stage for failed assets. Displays error message, prompt used, and model/tool
        info. Static replica below — the real component fetches diagnostic data via useAssetDiagnostic hook which
        requires a live API connection.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
        {/* With error + prompt + model + retry */}
        <div className="flex flex-col gap-4">
          <span className="text-[11px] font-mono text-red-400/70 uppercase tracking-[0.2em] bg-red-500/10 px-3 py-1 rounded-full w-fit">
            full diagnostic
          </span>
          <div className="h-[280px] bg-black/60 rounded-xl overflow-hidden ring-1 ring-red-500/20 shadow-[0_0_40px_-10px_rgba(255,50,50,0.12),inset_0_1px_0_rgba(255,50,50,0.1)]">
            <div className="w-full h-full bg-black/95 font-mono text-xs flex flex-col border border-red-500/30 rounded-xl">
              <div className="flex items-center gap-2 px-4 py-2 bg-red-950/50 border-b border-red-500/30 shrink-0">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                <span className="text-red-400 font-bold tracking-wider">@hero-intro-v3</span>
                <span className="text-red-500/60 ml-auto">FAILED</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                <div className="text-red-400 break-words">
                  Video generation failed: model returned empty response after 120s timeout. Quota may be exceeded.
                </div>
                <div className="space-y-1">
                  <span className="text-primary/50">Prompt:</span>
                  <div className="text-primary/80 break-words pl-2">
                    A slow-motion shot of ocean waves crashing against volcanic rocks at sunset, with golden light
                    filtering through the spray
                  </div>
                </div>
                <div className="text-primary/50 space-x-3">
                  <span>
                    Model: <span className="text-primary/70">veo3</span>
                  </span>
                  <span>
                    Tool: <span className="text-primary/70">generate_veo_video</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Minimal error — no prompt, no retry */}
        <div className="flex flex-col gap-4">
          <span className="text-[11px] font-mono text-red-400/70 uppercase tracking-[0.2em] bg-red-500/10 px-3 py-1 rounded-full w-fit">minimal (error only)</span>
          <div className="h-[280px] bg-black/60 rounded-xl overflow-hidden ring-1 ring-red-500/20 shadow-[0_0_40px_-10px_rgba(255,50,50,0.12),inset_0_1px_0_rgba(255,50,50,0.1)]">
            <div className="w-full h-full bg-black/95 font-mono text-xs flex flex-col border border-red-500/30 rounded-xl">
              <div className="flex items-center gap-2 px-4 py-2 bg-red-950/50 border-b border-red-500/30 shrink-0">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                <span className="text-red-400 font-bold tracking-wider">@corrupted-upload</span>
                <span className="text-red-500/60 ml-auto">FAILED</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                <div className="text-red-400 break-words">File upload interrupted: connection reset by peer</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


// ── VideoTrimView (static replica) ──

const TRIM_FILMSTRIP_HEIGHT = 80;
const TRIM_PLAYHEAD_POS = 42; // percent

const trimDemoWords = [
  { text: 'The', start: 0.0, end: 0.2 },
  { text: 'quick', start: 0.2, end: 0.5 },
  { text: 'brown', start: 0.5, end: 0.8 },
  { text: 'fox', start: 0.8, end: 1.1 },
  { text: 'jumps', start: 1.1, end: 1.5 },
  { text: 'over', start: 1.5, end: 1.8 },
  { text: 'the', start: 1.8, end: 2.0 },
  { text: 'lazy', start: 2.0, end: 2.4 },
  { text: 'dog.', start: 2.4, end: 2.8 },
  { text: 'A', start: 3.0, end: 3.1 },
  { text: 'second', start: 3.1, end: 3.5 },
  { text: 'sentence', start: 3.5, end: 4.0 },
  { text: 'appears', start: 4.0, end: 4.4 },
  { text: 'here', start: 4.4, end: 4.7 },
  { text: 'with', start: 4.7, end: 5.0 },
  { text: 'more', start: 5.0, end: 5.3 },
  { text: 'words.', start: 5.3, end: 5.7 },
  { text: 'Then', start: 6.0, end: 6.2 },
  { text: 'the', start: 6.2, end: 6.4 },
  { text: 'narrator', start: 6.4, end: 6.9 },
  { text: 'continues', start: 6.9, end: 7.4 },
  { text: 'speaking', start: 7.4, end: 7.9 },
  { text: 'about', start: 7.9, end: 8.2 },
  { text: 'the', start: 8.2, end: 8.4 },
  { text: 'product.', start: 8.4, end: 8.9 },
];

const trimDemoCutRegions = [
  { startPercent: 18, widthPercent: 12 },
  { startPercent: 62, widthPercent: 8 },
];

// Words at indices 5,6,7 ("over the lazy") are selected/cut
const trimSelectedWordIndices = new Set([5, 6, 7]);
// Active word index (currently playing)
const trimActiveWordIndex = 11;

const trimTimelineBadges = Array.from({ length: 6 }, (_, i) => ({
  percent: ((i + 0.5) / 6) * 100,
  src: i % 2 === 0 ? '/styleguide-img-cover.jpg' : '/styleguide-vid-purple-grind.jpg',
  time: `0:${Math.round(((i + 0.5) / 6) * 10).toString().padStart(2, '0')}`,
}));

const trimStripedBg = 'repeating-linear-gradient(-45deg, rgba(239,68,68,0.15) 0px 4px, rgba(239,68,68,0.35) 4px 8px)';

function VideoTrimViewSection() {
  return (
    <section className="mb-24">
      {/* Studio section header */}
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)] animate-pulse" />
          <h2 className="text-2xl font-mono font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-blue-400">VideoTrimView</h2>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-cyan-500/40 to-transparent" />
      </div>
      <p className="text-xs font-mono text-zinc-400 mb-8 max-w-2xl leading-relaxed pl-4 border-l-2 border-cyan-500/20">
        Full-screen trimming overlay. Two-column layout: video player + waveform timeline on left,
        transcript panel with word-level selection on right. Waveform shows audio shape with
        hover-expandable thumbnail badges at even intervals. Click words to mark cuts (shown with
        red strikethrough). Cut regions appear as striped red overlays on the timeline. Cyan playhead
        tracks current position. Supports snap-to-words, zoom, and inline word editing.
      </p>

      {/* Full-width demo -- studio equipment panel */}
      <div className="bg-zinc-950 border border-zinc-600/50 rounded-xl overflow-hidden ring-1 ring-cyan-500/10 shadow-[0_0_40px_rgba(34,211,238,0.06),inset_0_1px_0_rgba(255,255,255,0.03)]">
        {/* Header bar -- hardware rack style */}
        <div className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-zinc-700/60 bg-gradient-to-r from-zinc-900 via-zinc-900/95 to-zinc-950">
          <div className="flex items-center gap-2 text-zinc-400">
            <Scissors className="w-3.5 h-3.5" />
            <span className="font-mono text-[11px] tracking-widest uppercase">TRIMMING @HERO-INTRO</span>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              className={cn(
                'px-3.5 py-1 text-[11px] font-bold tracking-[0.15em] uppercase border rounded transition-all duration-200',
                'flex items-center justify-center gap-1.5',
                'bg-cyan-500/20 text-cyan-400 border-current',
                'shadow-[0_0_16px_rgba(34,211,238,0.4)]',
              )}
            >
              <Scissors className="w-3 h-3" />
              <span>TRIM</span>
            </button>
            <button className="w-6 h-6 flex items-center justify-center text-zinc-500 transition-all hover:bg-red-500/10 hover:text-red-400 rounded">
              <X className="w-4 h-4 stroke-[2.5]" />
            </button>
          </div>
        </div>

        {/* Main content: two-column */}
        <div className="flex overflow-hidden" style={{ height: 420 }}>
          {/* Left: video + timeline */}
          <div className="flex-1 flex flex-col px-3 py-2.5 overflow-hidden min-w-0">
            {/* Video player */}
            <div className="flex-1 min-h-0 flex items-center justify-center">
              <div className="relative w-full h-full bg-black rounded-md overflow-hidden">
                <video loop playsInline controls muted poster="/styleguide-img-cover.jpg" src="/fixtures/video-frost.mp4" className="w-full h-full object-contain" />
              </div>
            </div>

            {/* Timeline -- recessed panel */}
            <div className="shrink-0 mt-3 px-4 py-3 bg-zinc-900/60 rounded-lg border border-zinc-800/40 shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)]">
              <div className="relative">
                {/* Time ruler */}
                <div className="relative select-none" style={{ height: 20 }}>
                  {[0, 2, 4, 6, 8, 10].map((t) => (
                    <div key={t} className="absolute bottom-0" style={{ left: `${(t / 10) * 100}%` }}>
                      <div className="w-px h-3 bg-zinc-500" />
                      <span className="absolute bottom-0 text-[9px] text-zinc-400 font-mono leading-none whitespace-nowrap" style={{ transform: 'translateX(-50%)', left: 0, top: 1 }}>
                        0:{t.toString().padStart(2, '0')}
                      </span>
                    </div>
                  ))}
                  {[1, 3, 5, 7, 9].map((t) => (
                    <div key={t} className="absolute bottom-0" style={{ left: `${(t / 10) * 100}%` }}>
                      <div className="w-px h-1.5 bg-zinc-700" />
                    </div>
                  ))}
                </div>

                {/* Filmstrip */}
                <div className="relative overflow-visible" style={{ height: TRIM_FILMSTRIP_HEIGHT }}>
                  <div className="relative bg-black border border-zinc-700/50 rounded-md overflow-hidden" style={{ height: TRIM_FILMSTRIP_HEIGHT }}>
                    {/* Waveform */}
                    <div className="absolute inset-0 rounded-md overflow-hidden">
                      <StyleguideWaveform
                        url="/fixtures/video-frost.mp4"
                        height={TRIM_FILMSTRIP_HEIGHT}
                        waveColor="rgba(0, 255, 255, 0.15)"
                        progressColor="rgba(0, 255, 255, 0.5)"
                        progress={TRIM_PLAYHEAD_POS / 100}
                      />
                    </div>

                    {/* Cut region overlays */}
                    {trimDemoCutRegions.map((region, i) => (
                      <div
                        key={i}
                        className="absolute top-0 bottom-0 pointer-events-none z-10"
                        style={{
                          left: `${region.startPercent}%`,
                          width: `${region.widthPercent}%`,
                          background: trimStripedBg,
                        }}
                      />
                    ))}
                  </div>

                  {/* Thumbnail badges */}
                  {trimTimelineBadges.map((badge, i) => {
                    const inCut = trimDemoCutRegions.some(
                      (r) => badge.percent >= r.startPercent && badge.percent <= r.startPercent + r.widthPercent,
                    );
                    return (
                      <div
                        key={i}
                        className="group absolute z-20"
                        style={{
                          left: `${badge.percent}%`,
                          top: '50%',
                          transform: 'translate(-50%, -50%)',
                        }}
                      >
                        {/* Timestamp label — visible on hover */}
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-40">
                          <span className="text-[9px] font-mono text-cyan-400/70 whitespace-nowrap">{badge.time}</span>
                        </div>
                        {/* Badge */}
                        <div
                          className={cn(
                            'w-6 h-6 rounded-sm border border-cyan-500/30 bg-cover bg-center',
                            'transition-all duration-200 ease-out',
                            'group-hover:w-24 group-hover:h-[72px] group-hover:-translate-y-[calc(100%+4px)]',
                            'group-hover:shadow-[0_0_12px_rgba(34,211,238,0.4)] group-hover:border-cyan-400/60 group-hover:z-40',
                            'group-hover:rounded-md',
                            inCut && 'opacity-50',
                          )}
                          style={{ backgroundImage: `url(${badge.src})` }}
                        />
                      </div>
                    );
                  })}

                  {/* Edge handles for cut regions */}
                  {trimDemoCutRegions.map((region, i) => (
                    <div key={`handles-${i}`}>
                      <div className="absolute top-0 flex items-center justify-center" style={{ left: `${region.startPercent}%`, width: 8, marginLeft: -4, height: TRIM_FILMSTRIP_HEIGHT }}>
                        <div className="w-1 h-4/5 rounded-full bg-red-500/60" />
                      </div>
                      <div className="absolute top-0 flex items-center justify-center" style={{ left: `${region.startPercent + region.widthPercent}%`, width: 8, marginLeft: -4, height: TRIM_FILMSTRIP_HEIGHT }}>
                        <div className="w-1 h-4/5 rounded-full bg-red-500/60" />
                      </div>
                    </div>
                  ))}

                  {/* Playhead */}
                  <div
                    className="absolute top-0 pointer-events-none z-30"
                    style={{
                      left: `${TRIM_PLAYHEAD_POS}%`,
                      width: 3,
                      height: TRIM_FILMSTRIP_HEIGHT,
                      marginLeft: -1,
                      backgroundColor: 'rgb(34, 211, 238)',
                      filter: 'drop-shadow(0 0 6px rgba(34, 211, 238, 0.7))',
                    }}
                  >
                    <div
                      className="absolute"
                      style={{
                        top: -6,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        width: 0,
                        height: 0,
                        borderLeft: '5px solid transparent',
                        borderRight: '5px solid transparent',
                        borderTop: '6px solid rgb(34, 211, 238)',
                      }}
                    />
                  </div>
                </div>

                {/* Duration labels */}
                <div className="relative" style={{ height: 20 }}>
                  <div
                    className="absolute top-0.5 pointer-events-none z-30"
                    style={{ left: `${TRIM_PLAYHEAD_POS}%`, transform: 'translateX(-50%)' }}
                  >
                    <span className="font-mono text-[9px] text-cyan-400 bg-black/60 px-1 rounded">00:04.200</span>
                  </div>
                  {trimDemoCutRegions.map((region, i) => (
                    <div
                      key={i}
                      className="absolute top-1 text-[10px] text-red-400 font-mono font-medium whitespace-nowrap"
                      style={{
                        left: `${region.startPercent + region.widthPercent / 2}%`,
                        transform: 'translateX(-50%)',
                      }}
                    >
                      {(region.widthPercent / 10).toFixed(1)}s
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right: transcript panel */}
          <div className="w-[300px] shrink-0 flex flex-col border-l border-cyan-500/30 bg-gradient-to-b from-zinc-950 to-zinc-900/90 shadow-[inset_2px_0_16px_rgba(34,211,238,0.06)]">
            {/* Header -- LED panel accent */}
            <div className="shrink-0 px-4 py-2.5 border-b border-zinc-700/50 bg-zinc-900/80">
              <span className="text-[10px] font-mono tracking-[0.25em] uppercase text-cyan-500/70 drop-shadow-[0_0_4px_rgba(34,211,238,0.3)]">Transcript</span>
            </div>

            {/* Words */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 leading-relaxed scrollbar-hide">
              <div className="leading-relaxed">
                {trimDemoWords.map((word, i) => {
                  const isSelected = trimSelectedWordIndices.has(i);
                  const isActive = i === trimActiveWordIndex;
                  return (
                    <span key={i}>
                      <span
                        className={cn(
                          'inline-block text-sm font-sans cursor-pointer select-none',
                          'px-0.5 mx-0.5 my-0.5 rounded-sm transition-all duration-150',
                          isSelected
                            ? 'text-red-400/60 line-through decoration-red-500/80'
                            : isActive
                              ? 'text-cyan-300 bg-cyan-500/15 drop-shadow-[0_0_8px_#22d3ee]'
                              : 'text-zinc-300 hover:text-white'
                        )}
                      >
                        {word.text}
                      </span>
                      {word.text.endsWith('.') && <br />}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* Footer -- hardware display */}
            <div className="shrink-0 border-t border-zinc-700/50 px-4 py-3 space-y-2.5 bg-zinc-900/60">
              {/* Timestamp -- backlit display */}
              <div className="flex items-center gap-2 bg-black/60 rounded-md px-3 py-1.5 border border-zinc-800/60">
                <span className="font-mono text-sm text-cyan-400 tabular-nums drop-shadow-[0_0_6px_rgba(34,211,238,0.5)]">00:04.200</span>
                <span className="text-zinc-600 text-sm">/</span>
                <span className="font-mono text-sm text-zinc-500 tabular-nums">00:08.900</span>
              </div>
              {/* Controls */}
              <div className="flex items-center gap-1">
                <button className="p-1.5 rounded-md transition-colors flex items-center gap-1 bg-cyan-500/20 text-cyan-400">
                  <Magnet className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-medium">Snap</span>
                </button>
                <button className="p-1.5 rounded-md transition-colors flex items-center gap-1 bg-red-500/20 text-red-400">
                  <Eraser className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-medium">Clear</span>
                </button>
                <div className="w-px h-4 bg-zinc-700 mx-0.5" />
                <div className="flex items-center gap-1">
                  <button className="p-1 rounded text-zinc-400"><Minus className="w-3 h-3" /></button>
                  <input
                    type="range" min={1} max={10} step={1} defaultValue={1} readOnly
                    className="w-12 h-1 bg-zinc-700 rounded-full appearance-none cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2
                      [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:cursor-pointer"
                  />
                  <button className="p-1 rounded text-zinc-400"><Plus className="w-3 h-3" /></button>
                  <span className="text-[10px] text-cyan-400 w-4 text-right">1x</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


// ── Player Controls ──

function PlayerControlsSection() {
  return (
    <section className="mb-24">
      {/* Studio section header */}
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.6)] animate-pulse" />
          <h2 className="text-2xl font-mono font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-300 to-cyan-400">Player Controls</h2>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-blue-500/40 to-transparent" />
      </div>
      <p className="text-xs font-mono text-zinc-400 mb-8 max-w-2xl leading-relaxed pl-4 border-l-2 border-blue-500/20">
        Atomic building blocks for the player interface. TabButton for orientation selection,
        TimelineTabs for aspect ratio switching, SlugBadge for clip identification, and GearButton
        for settings access.
      </p>

      <div className="space-y-6 p-6 rounded-xl border border-zinc-600/40 bg-gradient-to-b from-zinc-950 to-zinc-900/80 ring-1 ring-blue-500/10 shadow-[0_0_30px_rgba(96,165,250,0.04),inset_0_1px_0_rgba(255,255,255,0.03)]">
        {/* TabButton */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-3 uppercase tracking-widest">TabButton (active / inactive)</p>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1 text-xs font-medium border transition-all bg-primary/20 border-primary/50 text-primary">
              <Monitor className="w-3.5 h-3.5 inline mr-1" />16:9
            </button>
            <button className="px-3 py-1 text-xs font-medium border transition-all bg-black/40 border-white/10 text-muted-foreground hover:border-white/20">
              <Smartphone className="w-3.5 h-3.5 inline mr-1" />9:16
            </button>
            <button className="px-3 py-1 text-xs font-medium border transition-all bg-black/40 border-white/10 text-muted-foreground hover:border-white/20">
              <Square className="w-3.5 h-3.5 inline mr-1" />1:1
            </button>
          </div>
        </div>

        {/* TimelineTabs */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-3 uppercase tracking-widest">TimelineTabs</p>
          <div className="flex items-center gap-1 bg-card/40 p-1 border border-primary/20 w-fit">
            <button className="px-3 py-1 text-xs font-medium border transition-all bg-black/40 border-white/10 text-muted-foreground">
              <Smartphone className="w-3.5 h-3.5 inline mr-1" />9:16
            </button>
            <button className="px-3 py-1 text-xs font-medium border transition-all bg-primary/20 border-primary/50 text-primary">
              <Monitor className="w-3.5 h-3.5 inline mr-1" />16:9
            </button>
            <button className="px-3 py-1 text-xs font-medium border transition-all bg-black/40 border-white/10 text-muted-foreground">
              <Square className="w-3.5 h-3.5 inline mr-1" />1:1
            </button>
          </div>
        </div>

        {/* SlugBadge */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-3 uppercase tracking-widest">SlugBadge</p>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">@hero-intro</span>
            <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">@product-shot-final-v2</span>
          </div>
        </div>

        {/* GearButton */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-3 uppercase tracking-widest">GearButton</p>
          <button className="p-1.5 rounded transition-colors text-muted-foreground hover:text-primary hover:bg-primary/10">
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>
    </section>
  );
}


// ── Player Interface ──

function RatioToggle({ active }: { active: '9:16' | '16:9' | '1:1' }) {
  const items: Array<{ icon: typeof Monitor; label: string; value: string }> = [
    { icon: Smartphone, label: '9:16', value: '9:16' },
    { icon: Monitor, label: '16:9', value: '16:9' },
    { icon: Square, label: '1:1', value: '1:1' },
  ];
  return (
    <div className="inline-flex gap-0.5 rounded-sm bg-black/60 p-0.5">
      {items.map(({ icon: Icon, label, value }) => (
        <button
          key={value}
          className={cn(
            'px-2 py-1 text-[10px] font-mono font-bold tracking-wider rounded-sm transition-all duration-150 flex items-center gap-1',
            value === active
              ? 'bg-primary/20 text-primary shadow-[0_0_8px_rgba(0,255,255,0.25)]'
              : 'text-white/40 hover:text-white/70 hover:bg-white/5'
          )}
        >
          <Icon className="w-3 h-3" />{label}
        </button>
      ))}
    </div>
  );
}

function PlayerInterfaceSection() {
  return (
    <section className="mb-24">
      {/* Studio section header */}
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)] animate-pulse" />
          <h2 className="text-2xl font-mono font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 to-cyan-400">Player Interface</h2>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-emerald-500/40 to-transparent" />
      </div>
      <p className="text-xs font-mono text-zinc-400 mb-8 max-w-2xl leading-relaxed pl-4 border-l-2 border-emerald-500/20">
        Complete ClipPlayer shell showing landscape (active), portrait (idle), square (rendering),
        and video error states. Header contains TimelineTabs, SlugBadge, and GearButton.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6 rounded-xl bg-gradient-to-b from-zinc-950 to-zinc-900/60 border border-zinc-600/40 ring-1 ring-emerald-500/10 shadow-[0_0_30px_rgba(52,211,153,0.04),inset_0_1px_0_rgba(255,255,255,0.03)]">
        {/* Landscape (active) */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-3 uppercase tracking-widest">Landscape (active)</p>
          <div className="flex flex-col h-[300px] border border-zinc-600/50 rounded-xl overflow-hidden shadow-lg ring-1 ring-zinc-700/30">
            <div className="shrink-0 px-3 py-1.5 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between">
              <RatioToggle active="16:9" />
              <span className="font-mono text-xs text-muted-foreground truncate max-w-[120px]">@hero-intro</span>
              <button className="p-1 rounded text-muted-foreground hover:text-primary">
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 bg-black flex items-center justify-center">
              <video
                src="/fixtures/video-frost.mp4"
                className="w-full h-full object-contain"
                controls
                loop
                muted
                playsInline
              />
            </div>
          </div>
        </div>

        {/* Portrait (idle) — LazyRenderPlaceholder */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-3 uppercase tracking-widest">Portrait (idle) — LazyRenderPlaceholder</p>
          <div className="flex flex-col h-[300px] border border-zinc-600/50 rounded-xl overflow-hidden shadow-lg ring-1 ring-zinc-700/30">
            <div className="shrink-0 px-3 py-1.5 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between">
              <RatioToggle active="9:16" />
              <span className="font-mono text-xs text-muted-foreground">@hero-intro</span>
              <button className="p-1 rounded text-muted-foreground"><Settings className="w-3.5 h-3.5" /></button>
            </div>
            <div className="flex-1 bg-black/90 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Plus className="w-8 h-8" />
              <span className="text-sm">Create portrait render</span>
            </div>
          </div>
        </div>

        {/* Square (rendering) */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-3 uppercase tracking-widest">Square (rendering)</p>
          <div className="flex flex-col h-[300px] border border-zinc-600/50 rounded-xl overflow-hidden shadow-lg ring-1 ring-zinc-700/30">
            <div className="shrink-0 px-3 py-1.5 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between">
              <RatioToggle active="1:1" />
              <span className="font-mono text-xs text-muted-foreground">@hero-intro</span>
              <button className="p-1 rounded text-muted-foreground"><Settings className="w-3.5 h-3.5" /></button>
            </div>
            <div className="flex-1 bg-black/90 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
              <span className="text-sm">Rendering square...</span>
            </div>
          </div>
        </div>

        {/* Video error */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-3 uppercase tracking-widest">Video error</p>
          <div className="flex flex-col h-[300px] border border-zinc-600/50 rounded-xl overflow-hidden shadow-lg ring-1 ring-zinc-700/30">
            <div className="shrink-0 px-3 py-1.5 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between">
              <RatioToggle active="16:9" />
              <span className="font-mono text-xs text-muted-foreground">@broken-clip</span>
              <button className="p-1 rounded text-muted-foreground"><Settings className="w-3.5 h-3.5" /></button>
            </div>
            <div className="flex-1 bg-black flex flex-col items-center justify-center gap-2 text-destructive">
              <AlertTriangle className="w-8 h-8" />
              <span className="text-sm font-medium">Video playback error</span>
              <span className="text-xs text-muted-foreground">Failed to load media resource</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


// ── Audio Player ──

function AudioPlayerSection() {
  return (
    <section className="mb-24">
      {/* Studio section header */}
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.6)] animate-pulse" />
          <h2 className="text-2xl font-mono font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-violet-300 to-cyan-400">Audio Player</h2>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-violet-500/40 to-transparent" />
      </div>
      <p className="text-xs font-mono text-zinc-400 mb-8 max-w-2xl leading-relaxed pl-4 border-l-2 border-violet-500/20">
        Full audio editing interface with waveform visualization, trim handles, cut regions,
        fade controls, and playback. Header shows slug, vocals badge, keep/cut toggle, and action buttons.
      </p>

      <div className="border border-zinc-600/50 rounded-xl overflow-hidden bg-zinc-950 ring-1 ring-violet-500/10 shadow-[0_0_40px_rgba(167,139,250,0.06),inset_0_1px_0_rgba(255,255,255,0.03)]">
        {/* Header -- studio console strip */}
        <div className="shrink-0 px-5 py-3 border-b border-zinc-700/50 flex items-center justify-between bg-gradient-to-r from-zinc-900 via-zinc-900/95 to-zinc-950">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-foreground">@BACKGROUND-MUSIC</span>
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-violet-500/20 text-violet-400 border border-violet-500/30">
              VOCALS
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Keep / Cut toggle */}
            <div className="flex border border-primary/30 rounded overflow-hidden">
              <button className="px-2 py-1 text-xs font-medium bg-primary/20 border-r border-primary/30 text-primary">Keep</button>
              <button className="px-2 py-1 text-xs font-medium bg-black/40 text-muted-foreground">Cut</button>
            </div>
            {/* TRIM button with confirmation popup */}
            <div className="relative">
              <button className="px-3 py-1 text-xs font-bold tracking-wider border rounded transition-all bg-cyan-500/20 text-cyan-400 border-current shadow-[0_0_12px_rgba(34,211,238,0.3)]">
                <Scissors className="w-3 h-3 inline mr-1" />TRIM
              </button>
              {/* Confirmation popup (shown) */}
              <div className="absolute top-full mt-1 right-0 z-50 bg-black/95 border border-primary/30 rounded p-3 shadow-lg w-48">
                <p className="text-xs text-muted-foreground mb-2">Apply trim to audio?</p>
                <div className="flex gap-2">
                  <button className="flex-1 px-2 py-1 text-xs bg-primary/20 text-primary border border-primary/40 rounded">Confirm</button>
                  <button className="flex-1 px-2 py-1 text-xs bg-black/40 text-muted-foreground border border-white/10 rounded">Cancel</button>
                </div>
              </div>
            </div>
            {/* ISOLATE VOCALS */}
            <button className="px-3 py-1 text-xs font-bold tracking-wider border rounded transition-all bg-violet-500/20 text-violet-400 border-violet-500/40">
              <Mic className="w-3 h-3 inline mr-1" />ISOLATE VOCALS
            </button>
          </div>
        </div>

        {/* Waveform area -- recessed display panel */}
        <div className="relative px-5 py-4 bg-gradient-to-b from-zinc-950 to-black/80" style={{ minHeight: 140 }}>
          {/* Waveform */}
          <div className="relative w-full" style={{ height: 80 }}>
            <StyleguideWaveform url="/fixtures/audio-storm.mp3" height={80} progress={0.4} />

            {/* Trim region overlay — left handle at ~15%, right at ~75% */}
            <div className="absolute top-0 bottom-0 left-0 bg-black/50 pointer-events-none" style={{ width: '15%' }} />
            <div className="absolute top-0 bottom-0 right-0 bg-black/50 pointer-events-none" style={{ width: '25%' }} />

            {/* Cut region (red) — small section between 45% and 55% */}
            <div
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                left: '45%',
                width: '10%',
                background: 'rgba(239, 68, 68, 0.2)',
                borderLeft: '2px solid rgba(239, 68, 68, 0.6)',
                borderRight: '2px solid rgba(239, 68, 68, 0.6)',
              }}
            />

            {/* Left trim handle */}
            <div
              className="absolute top-0 bottom-0 cursor-ew-resize z-20 flex items-center"
              style={{ left: '15%', width: 6, marginLeft: -3 }}
            >
              <div className="w-0.5 h-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.7)]" />
            </div>

            {/* Right trim handle */}
            <div
              className="absolute top-0 bottom-0 cursor-ew-resize z-20 flex items-center"
              style={{ left: '75%', width: 6, marginLeft: -3 }}
            >
              <div className="w-0.5 h-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.7)]" />
            </div>

            {/* Fade-in handle (yellow, left side) */}
            <div
              className="absolute top-0 z-10 pointer-events-none"
              style={{ left: '15%', width: '8%', height: '100%' }}
            >
              <div className="w-full h-full" style={{ background: 'linear-gradient(to right, rgba(250,204,21,0.4), transparent)' }} />
            </div>

            {/* Fade-out handle (yellow, right side) */}
            <div
              className="absolute top-0 z-10 pointer-events-none"
              style={{ right: '25%', width: '6%', height: '100%' }}
            >
              <div className="w-full h-full" style={{ background: 'linear-gradient(to left, rgba(250,204,21,0.4), transparent)' }} />
            </div>

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 z-30 pointer-events-none shadow-[0_0_6px_rgba(34,211,238,0.7)]"
              style={{ left: '40%' }}
            />
          </div>
        </div>

        {/* Audio settings row -- console strip */}
        <div className="px-5 py-3 border-t border-zinc-700/50 flex items-center gap-6 flex-wrap bg-zinc-900/40">
          {/* Fade In */}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-yellow-400/90 w-14 shrink-0">Fade In</span>
            <input
              type="range" min={0} max={2000} defaultValue={500} readOnly
              className="w-20 h-1 bg-zinc-700 rounded-full appearance-none
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-yellow-400 [&::-webkit-slider-thumb]:cursor-pointer"
            />
            <span className="text-xs font-mono text-yellow-400/80 w-12">500ms</span>
          </div>
          {/* Fade Out */}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-yellow-400/90 w-14 shrink-0">Fade Out</span>
            <input
              type="range" min={0} max={2000} defaultValue={300} readOnly
              className="w-20 h-1 bg-zinc-700 rounded-full appearance-none
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-yellow-400 [&::-webkit-slider-thumb]:cursor-pointer"
            />
            <span className="text-xs font-mono text-yellow-400/80 w-12">300ms</span>
          </div>
          {/* Volume */}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-amber-400/90 w-14 shrink-0">Volume</span>
            <input
              type="range" min={50} max={500} defaultValue={100} readOnly
              className="w-20 h-1 bg-zinc-700 rounded-full appearance-none
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-400 [&::-webkit-slider-thumb]:cursor-pointer"
            />
            <span className="text-xs font-mono text-amber-400/80 w-12">100%</span>
          </div>
          {/* APPLY button */}
          <button className="px-4 py-1 text-xs font-bold tracking-wider bg-primary/20 text-primary border border-primary/40 rounded shadow-[0_0_8px_rgba(0,255,255,0.2)]">
            APPLY
          </button>
        </div>

        {/* Playback controls -- transport bar */}
        <div className="px-5 py-3 border-t border-zinc-700/50 flex items-center gap-4 bg-zinc-900/60">
          <button className="w-9 h-9 rounded-full border border-primary/50 bg-primary/15 flex items-center justify-center text-primary shadow-[0_0_12px_rgba(34,211,238,0.2)] hover:shadow-[0_0_20px_rgba(34,211,238,0.3)] transition-shadow">
            <Play className="w-4 h-4 ml-0.5" />
          </button>
          <div className="font-mono text-sm tabular-nums bg-black/50 rounded-md px-3 py-1 border border-zinc-800/60">
            <span className="text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.5)]">01:23</span>
            <span className="text-zinc-600 mx-1">/</span>
            <span className="text-zinc-500">03:45</span>
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            <Volume2 className="w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="range" min={0} max={100} defaultValue={80} readOnly
              className="w-20 h-1 bg-zinc-700 rounded-full appearance-none
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer"
            />
          </div>
        </div>
      </div>
    </section>
  );
}


// ── Audio Track ──

function AudioTrackSection() {
  return (
    <section className="mb-24">
      {/* Studio section header */}
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-fuchsia-400 shadow-[0_0_8px_rgba(232,121,249,0.6)] animate-pulse" />
          <h2 className="text-2xl font-mono font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-fuchsia-300 to-cyan-400">Audio Track</h2>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-fuchsia-500/40 to-transparent" />
      </div>
      <p className="text-xs font-mono text-zinc-400 mb-8 max-w-2xl leading-relaxed pl-4 border-l-2 border-fuchsia-500/20">
        Audio track states for the timeline: empty drop zone (default and collapsed), assigning,
        active tracks with waveform and controls, and multi-track lane composition.
      </p>

      <div className="space-y-5 p-6 rounded-xl bg-gradient-to-b from-zinc-950 to-zinc-900/60 border border-zinc-600/40 ring-1 ring-fuchsia-500/10 shadow-[0_0_30px_rgba(232,121,249,0.04),inset_0_1px_0_rgba(255,255,255,0.03)]">
        {/* Empty (default) */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2.5 uppercase tracking-widest">Empty (default)</p>
          <div className="border border-dashed rounded-md flex items-center justify-center gap-2 transition-colors h-14 min-h-14 border-zinc-600/40 text-muted-foreground/40">
            <Music className="w-3.5 h-3.5" />
            <span className="font-mono text-xs">DROP_AUDIO_TRACK</span>
          </div>
        </div>

        {/* Empty (collapsed) */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2.5 uppercase tracking-widest">Empty (collapsed)</p>
          <div className="border border-dashed rounded-md flex items-center justify-center gap-2 transition-colors h-8 min-h-8 border-zinc-600/40 text-muted-foreground/40">
            <Music className="w-3 h-3" />
            <span className="font-mono text-[10px]">DROP_AUDIO_TRACK</span>
          </div>
        </div>

        {/* Assigning */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2.5 uppercase tracking-widest">Assigning</p>
          <div className="h-14 min-h-14 border border-zinc-700/40 bg-primary/5 rounded-md flex items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="font-mono text-xs tracking-wider">ASSIGNING...</span>
          </div>
        </div>

        {/* Active (cyan) */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2.5 uppercase tracking-widest">Active (cyan)</p>
          <div className="relative h-14 border border-cyan-400/30 bg-cyan-950/10 rounded-md overflow-hidden">
            {/* Positioned audio block */}
            <div
              className="absolute top-0 bottom-0 rounded border border-cyan-400/40 bg-cyan-950/30 overflow-hidden"
              style={{ left: '10%', width: '60%' }}
            >
              {/* Waveform inside block */}
              <div className="absolute inset-0 px-1 flex items-center">
                <StyleguideWaveform url="/fixtures/audio-red.mp3" height={36} waveColor="rgba(0, 255, 255, 0.3)" progressColor="rgba(0, 255, 255, 0.6)" />
              </div>
              {/* Slug label */}
              <div className="absolute bottom-0.5 left-1 z-20">
                <span className="text-[10px] font-mono text-cyan-400/80 px-1 py-0.5 rounded bg-black/70">@bg-music</span>
              </div>
              {/* Fade-in handle */}
              <div className="absolute top-0 left-0 bottom-0 z-10" style={{ width: '8%' }}>
                <div className="w-full h-full" style={{ background: 'linear-gradient(to right, rgba(250,204,21,0.6), transparent)' }} />
              </div>
              {/* Fade-out handle */}
              <div className="absolute top-0 right-0 bottom-0 z-10" style={{ width: '5%' }}>
                <div className="w-full h-full" style={{ background: 'linear-gradient(to left, rgba(250,204,21,0.6), transparent)' }} />
              </div>
              {/* Resize handles */}
              <div className="absolute top-0 left-0 bottom-0 w-1 cursor-ew-resize hover:bg-cyan-400/40 z-20" />
              <div className="absolute top-0 right-0 bottom-0 w-1 cursor-ew-resize hover:bg-cyan-400/40 z-20" />
            </div>
          </div>
        </div>

        {/* Active (magenta) */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2.5 uppercase tracking-widest">Active (magenta)</p>
          <div className="relative h-14 border border-fuchsia-400/30 bg-fuchsia-950/10 rounded-md overflow-hidden">
            <div
              className="absolute top-0 bottom-0 rounded border border-fuchsia-400/40 bg-fuchsia-950/30 overflow-hidden"
              style={{ left: '20%', width: '50%' }}
            >
              <div className="absolute inset-0 px-1 flex items-center">
                <StyleguideWaveform url="/fixtures/sfx-hit.mp3" height={36} waveColor="rgba(217, 70, 239, 0.3)" progressColor="rgba(217, 70, 239, 0.6)" />
              </div>
              <div className="absolute bottom-0.5 left-1 z-20">
                <span className="text-[10px] font-mono text-fuchsia-400/80 px-1 py-0.5 rounded bg-black/70">@sfx-hit</span>
              </div>
              <div className="absolute top-0 left-0 bottom-0 z-10" style={{ width: '6%' }}>
                <div className="w-full h-full" style={{ background: 'linear-gradient(to right, rgba(250,204,21,0.6), transparent)' }} />
              </div>
              <div className="absolute top-0 right-0 bottom-0 z-10" style={{ width: '4%' }}>
                <div className="w-full h-full" style={{ background: 'linear-gradient(to left, rgba(250,204,21,0.6), transparent)' }} />
              </div>
              <div className="absolute top-0 left-0 bottom-0 w-1 cursor-ew-resize hover:bg-fuchsia-400/40 z-20" />
              <div className="absolute top-0 right-0 bottom-0 w-1 cursor-ew-resize hover:bg-fuchsia-400/40 z-20" />
            </div>
          </div>
        </div>

        {/* Multi-track lane */}
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2.5 uppercase tracking-widest">Multi-track lane</p>
          <div className="relative h-14 border border-zinc-700/30 bg-zinc-950/40 rounded-md overflow-hidden">
            {/* Track 1 (cyan) */}
            <div
              className="absolute top-0 bottom-0 rounded border border-cyan-400/40 bg-cyan-950/30 overflow-hidden"
              style={{ left: '5%', width: '45%' }}
            >
              <div className="absolute inset-0 px-1 flex items-center">
                <StyleguideWaveform url="/fixtures/audio-red.mp3" height={36} waveColor="rgba(0, 255, 255, 0.3)" />
              </div>
              <div className="absolute bottom-0.5 left-1 z-20">
                <span className="text-[10px] font-mono text-cyan-400/80 px-1 py-0.5 rounded bg-black/70">@music</span>
              </div>
            </div>
            {/* Track 2 (magenta, overlapping) */}
            <div
              className="absolute top-0 bottom-0 rounded border border-fuchsia-400/40 bg-fuchsia-950/30 overflow-hidden"
              style={{ left: '55%', width: '35%' }}
            >
              <div className="absolute inset-0 px-1 flex items-center">
                <StyleguideWaveform url="/fixtures/sfx-click.mp3" height={36} waveColor="rgba(217, 70, 239, 0.3)" />
              </div>
              <div className="absolute bottom-0.5 left-1 z-20">
                <span className="text-[10px] font-mono text-fuchsia-400/80 px-1 py-0.5 rounded bg-black/70">@voiceover</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


// ── Timeline Scrubber ──

function TimelineScrubberSection() {
  return (
    <section className="mb-24">
      {/* Studio section header */}
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)] animate-pulse" />
          <h2 className="text-2xl font-mono font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-amber-300 to-cyan-400">Timeline Scrubber</h2>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-amber-500/40 to-transparent" />
      </div>
      <p className="text-xs font-mono text-zinc-400 mb-8 max-w-2xl leading-relaxed pl-4 border-l-2 border-amber-500/20">
        Assembled timeline with video slots, playhead, audio track lane, and empty drop zone.
        Demonstrates full scrubber composition with proportional slot widths and audio positioning.
      </p>

      <div className="border border-zinc-600/50 rounded-xl overflow-hidden bg-zinc-950 ring-1 ring-amber-500/10 shadow-[0_0_40px_rgba(251,191,36,0.06),inset_0_1px_0_rgba(255,255,255,0.03)]">
        {/* Video slots + playhead -- recessed panel */}
        <div className="relative h-32 flex gap-0.5 bg-gradient-to-b from-zinc-900/40 to-zinc-950">
          <TimelineSlotDemo label="@s01" hasContent thumbnailSrc="/styleguide-vid-purple-grind.jpg" assetId="vid-purple-grind" flex={3} />
          <TimelineSlotDemo label="@s02" hasContent thumbnailSrc="/styleguide-img-neon-fox.jpg" assetId="vid-neon-fox" isActive flex={2} />
          <TimelineSlotDemo label="@s03" hasContent thumbnailSrc="/styleguide-vid-sky-ghost.jpg" assetId="vid-sky-ghost" flex={3} />
          <TimelineSlotDemo label="@s04" flex={2} />
          <TimelineSlotDemo label="@s05" flex={2} />
          {/* Playhead at 42% */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-primary z-[100] pointer-events-none shadow-[0_0_8px_var(--color-primary)]"
            style={{ left: '42%' }}
          />
        </div>

        {/* Audio track lane with positioned block */}
        <div className="relative h-16 border-t border-zinc-700/50 bg-zinc-900/30">
          <div
            className="absolute top-0 bottom-0 rounded border border-cyan-400/40 bg-cyan-950/30 overflow-hidden"
            style={{ left: '8%', width: '55%' }}
          >
            <div className="absolute inset-0 px-1 flex items-center">
              <StyleguideWaveform url="/fixtures/audio-red.mp3" height={36} progress={0.42} />
            </div>
            <div className="absolute bottom-0.5 left-1 z-20">
              <span className="text-[10px] font-mono text-cyan-400/80 px-1 py-0.5 rounded bg-black/70">@bg-music</span>
            </div>
          </div>
          {/* Playhead extension into audio lane */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-primary z-[100] pointer-events-none shadow-[0_0_8px_var(--color-primary)]"
            style={{ left: '42%' }}
          />
        </div>

        {/* Empty drop zone for second track */}
        <div className="border-t border-zinc-800/60">
          <div className="border border-dashed flex items-center justify-center gap-2 transition-colors h-10 min-h-10 border-zinc-600/40 text-muted-foreground/40 m-0.5 rounded-md">
            <Music className="w-3 h-3" />
            <span className="font-mono text-[10px]">DROP_AUDIO_TRACK</span>
          </div>
        </div>
      </div>
    </section>
  );
}


// ── Video Settings Modal ──

function VideoSettingsModalSection() {
  return (
    <section className="mb-24">
      {/* Premium section header with gradient accent */}
      <div className="mb-10">
        <div className="flex items-center gap-4 mb-3">
          <div className="w-1 h-8 bg-gradient-to-b from-primary via-primary/60 to-transparent rounded-full" />
          <h2 className="text-2xl font-mono font-bold tracking-tight text-foreground">Video Settings Modal</h2>
        </div>
        <p className="text-sm font-mono text-muted-foreground ml-5 pl-4 border-l border-zinc-800/60">
          Static render of the video render settings panel. Matches the render_video MCP tool parameters:
          orientation, audio, subtitles, and OSG overlay.
        </p>
      </div>

      {/* Outer luxury container — automotive HUD display panel */}
      <div className="relative max-w-3xl mx-auto rounded-xl bg-gradient-to-b from-zinc-900/80 to-zinc-950/90 border border-zinc-700/40 p-6 shadow-[0_8px_60px_-15px_rgba(0,0,0,0.7),0_0_40px_-10px_rgba(0,255,255,0.08)]">
        {/* Subtle top highlight line */}
        <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

        <div
          className="relative overflow-hidden rounded-lg border border-primary/40 bg-black/95 shadow-[0_0_30px_rgba(0,255,255,0.15),inset_0_0_30px_rgba(0,255,255,0.05)]"
          style={{
            backgroundImage: 'linear-gradient(rgba(0,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,255,0.03) 1px, transparent 1px)',
            backgroundSize: '4px 4px',
          }}
        >
          {/* Scanlines overlay */}
          <div className="scanlines pointer-events-none absolute inset-0 opacity-20" />

          {/* Header */}
          <div className="relative px-6 pt-5 pb-3 border-b border-primary/20">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-primary/60 shadow-[0_0_8px_rgba(0,255,255,0.5)]" />
              <h3 className="text-sm font-mono font-bold text-primary tracking-[0.2em] uppercase">Render Settings</h3>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 ml-5 font-mono tracking-wide">vid-hero-intro — my-project</p>
          </div>

          {/* Body */}
          <div className="relative px-6 py-5 space-y-5">

            {/* ── Two-column grid ── */}
            <div className="grid grid-cols-2 gap-x-8 gap-y-5">

              {/* Left column: Orientation + Subtitles */}
              <div className="space-y-5">

                {/* ── Orientation Section ── */}
                <div className="relative border border-primary/20 bg-black/50 rounded-lg p-4 shadow-[inset_0_1px_0_rgba(0,255,255,0.06)]">
                  {/* Corner brackets — larger */}
                  <div className="absolute top-0 left-0 w-2 h-2 border-l-2 border-t-2 border-primary/50" />
                  <div className="absolute top-0 right-0 w-2 h-2 border-r-2 border-t-2 border-primary/50" />
                  <div className="absolute bottom-0 left-0 w-2 h-2 border-l-2 border-b-2 border-primary/50" />
                  <div className="absolute bottom-0 right-0 w-2 h-2 border-r-2 border-b-2 border-primary/50" />
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-0.5 h-3 bg-primary/50 rounded-full" />
                    <span className="text-xs font-mono font-bold uppercase tracking-[0.15em] text-foreground">Orientations to Render</span>
                  </div>
                  <div className="space-y-2 mt-3">
                    {['Landscape', 'Portrait'].map((opt) => (
                      <label key={opt} className="flex items-center gap-3 cursor-pointer group py-0.5">
                        <div className={cn(
                          'w-4 h-4 rounded-sm border flex items-center justify-center transition-all',
                          'bg-primary/20 border-primary/50 shadow-[0_0_6px_rgba(0,255,255,0.2)]'
                        )}>
                          <svg className="w-2.5 h-2.5 text-primary" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="2 6 5 9 10 3" />
                          </svg>
                        </div>
                        <span className="text-sm text-foreground group-hover:text-primary transition-colors">{opt}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* ── Subtitles Section ── */}
                <div className="relative border border-primary/20 bg-black/50 rounded-lg p-4 shadow-[inset_0_1px_0_rgba(0,255,255,0.06)]">
                  {/* Corner brackets */}
                  <div className="absolute top-0 left-0 w-2 h-2 border-l-2 border-t-2 border-primary/50" />
                  <div className="absolute top-0 right-0 w-2 h-2 border-r-2 border-t-2 border-primary/50" />
                  <div className="absolute bottom-0 left-0 w-2 h-2 border-l-2 border-b-2 border-primary/50" />
                  <div className="absolute bottom-0 right-0 w-2 h-2 border-r-2 border-b-2 border-primary/50" />
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-0.5 h-3 bg-primary/50 rounded-full" />
                      <span className="text-xs font-mono font-bold uppercase tracking-[0.15em] text-foreground">Subtitles</span>
                    </div>
                    <button className="px-2.5 py-1 text-[10px] font-bold bg-primary/25 border border-primary/50 text-primary rounded shadow-[0_0_8px_rgba(0,255,255,0.2)]">ON</button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1.5 tracking-wide">Highlight Style</span>
                      <div className="flex gap-1.5">
                        {['TikDance', 'Highlight'].map((opt, i) => (
                          <button
                            key={opt}
                            className={cn(
                              'flex-1 px-3 py-1.5 text-xs font-medium border rounded-sm transition-all',
                              i === 0 ? 'bg-primary/20 border-primary/50 text-primary shadow-[0_0_8px_rgba(0,255,255,0.15)]' : 'bg-black/40 border-white/10 text-muted-foreground'
                            )}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1.5 tracking-wide">Position</span>
                      <div className="flex gap-1.5">
                        {['Top', 'Middle', 'Bottom'].map((opt, i) => (
                          <button
                            key={opt}
                            className={cn(
                              'flex-1 px-3 py-1.5 text-xs font-medium border rounded-sm transition-all',
                              i === 2 ? 'bg-primary/20 border-primary/50 text-primary shadow-[0_0_8px_rgba(0,255,255,0.15)]' : 'bg-black/40 border-white/10 text-muted-foreground'
                            )}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1.5 tracking-wide">Font Size</span>
                      <div className="flex gap-1.5">
                        {['S', 'M', 'L'].map((opt, i) => (
                          <button
                            key={opt}
                            className={cn(
                              'flex-1 px-3 py-1.5 text-xs font-medium border rounded-sm transition-all',
                              i === 1 ? 'bg-primary/20 border-primary/50 text-primary shadow-[0_0_8px_rgba(0,255,255,0.15)]' : 'bg-black/40 border-white/10 text-muted-foreground'
                            )}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Gradient divider before color swatches */}
                    <div className="h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent my-1" />
                    <div className="flex gap-6 pt-1">
                      <div className="flex items-center gap-2.5">
                        <span className="text-xs text-muted-foreground tracking-wide">Text</span>
                        <div className="w-9 h-9 rounded-md border border-white/15 bg-black/30 p-1.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]">
                          <div className="w-full h-full rounded-sm bg-slate-50" />
                        </div>
                        <span className="text-xs font-mono text-muted-foreground">#F8FAFC</span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <span className="text-xs text-muted-foreground tracking-wide">Highlight</span>
                        <div className="w-9 h-9 rounded-md border border-white/15 bg-black/30 p-1.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]">
                          <div className="w-full h-full rounded-sm bg-red-800" />
                        </div>
                        <span className="text-xs font-mono text-muted-foreground">#991B1B</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right column: Audio + OSG */}
              <div className="space-y-5">

                {/* ── Audio Section ── */}
                <div className="relative border border-primary/20 bg-black/50 rounded-lg p-4 shadow-[inset_0_1px_0_rgba(0,255,255,0.06)]">
                  {/* Corner brackets */}
                  <div className="absolute top-0 left-0 w-2 h-2 border-l-2 border-t-2 border-primary/50" />
                  <div className="absolute top-0 right-0 w-2 h-2 border-r-2 border-t-2 border-primary/50" />
                  <div className="absolute bottom-0 left-0 w-2 h-2 border-l-2 border-b-2 border-primary/50" />
                  <div className="absolute bottom-0 right-0 w-2 h-2 border-r-2 border-b-2 border-primary/50" />
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-0.5 h-3 bg-primary/50 rounded-full" />
                      <span className="text-xs font-mono font-bold uppercase tracking-[0.15em] text-foreground">Audio</span>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs w-16 shrink-0 text-muted-foreground tracking-wide">Fade In</span>
                      <input
                        type="number" defaultValue={250} min={0} max={5000} readOnly
                        className="flex-1 bg-black/50 border border-white/15 text-xs font-mono px-3 py-1.5 rounded-md focus:border-primary/50"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs w-16 shrink-0 text-muted-foreground tracking-wide">Fade Out</span>
                      <input
                        type="number" defaultValue={1000} min={0} max={5000} readOnly
                        className="flex-1 bg-black/50 border border-white/15 text-xs font-mono px-3 py-1.5 rounded-md focus:border-primary/50"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs w-16 shrink-0 text-muted-foreground tracking-wide">Volume</span>
                      <input
                        type="number" defaultValue={60} min={0} max={100} readOnly
                        className="flex-1 bg-black/50 border border-white/15 text-xs font-mono px-3 py-1.5 rounded-md focus:border-primary/50"
                      />
                    </div>
                    {/* Gradient divider */}
                    <div className="h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
                    <div className="flex gap-2 pt-1">
                      {[
                        { label: '60%', fadeIn: 250, fadeOut: 1000, vol: 60 },
                        { label: '80%', fadeIn: 250, fadeOut: 1000, vol: 80 },
                      ].map((p) => (
                        <button key={p.label} className="flex-1 px-3 py-1.5 text-[10px] font-bold border rounded-sm bg-black/40 border-white/15 text-muted-foreground hover:border-primary/50 hover:text-primary transition-all tracking-wider">
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* ── OSG Section ── */}
                <div className="relative border border-primary/20 bg-black/50 rounded-lg p-4 shadow-[inset_0_1px_0_rgba(0,255,255,0.06)]">
                  {/* Corner brackets */}
                  <div className="absolute top-0 left-0 w-2 h-2 border-l-2 border-t-2 border-primary/50" />
                  <div className="absolute top-0 right-0 w-2 h-2 border-r-2 border-t-2 border-primary/50" />
                  <div className="absolute bottom-0 left-0 w-2 h-2 border-l-2 border-b-2 border-primary/50" />
                  <div className="absolute bottom-0 right-0 w-2 h-2 border-r-2 border-b-2 border-primary/50" />
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-0.5 h-3 bg-primary/50 rounded-full" />
                      <span className="text-xs font-mono font-bold uppercase tracking-[0.15em] text-foreground">OSG</span>
                    </div>
                    <button className="px-2.5 py-1 text-[10px] font-bold bg-primary/25 border border-primary/50 text-primary rounded shadow-[0_0_8px_rgba(0,255,255,0.2)]">ON</button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1.5 tracking-wide">Asset ID</span>
                      <input
                        type="text" defaultValue="img-logo-overlay" readOnly
                        className="w-full bg-black/50 border border-white/15 text-xs font-mono px-3 py-1.5 rounded-md focus:border-primary/50"
                      />
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1.5 tracking-wide">Position</span>
                      <div className="grid grid-cols-2 gap-1.5">
                        {['Top-Left', 'Top-Right', 'Bottom-Left', 'Bottom-Right'].map((pos, i) => (
                          <button
                            key={pos}
                            className={cn(
                              'px-3 py-1.5 text-[10px] font-medium border rounded-sm transition-all',
                              i === 1 ? 'bg-primary/20 border-primary/50 text-primary shadow-[0_0_8px_rgba(0,255,255,0.15)]' : 'bg-black/40 border-white/15 text-muted-foreground'
                            )}
                          >
                            {pos}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="relative px-6 py-4 border-t border-primary/20">
            <button className="w-full py-2.5 text-sm font-bold tracking-[0.2em] uppercase bg-primary/20 text-primary border border-primary/40 rounded-lg shadow-[0_0_25px_rgba(0,255,255,0.25),inset_0_1px_0_rgba(0,255,255,0.1)] hover:bg-primary/30 hover:shadow-[0_0_35px_rgba(0,255,255,0.35)] transition-all">
              Apply Settings
            </button>
          </div>
        </div>

        {/* Bottom highlight line */}
        <div className="absolute bottom-0 left-12 right-12 h-px bg-gradient-to-r from-transparent via-zinc-700/30 to-transparent" />
      </div>
    </section>
  );
}


// ── CollapsibleSidebar ──

function CollapsibleSidebarSection() {
  return (
    <section className="mb-24">
      {/* Premium section header */}
      <div className="mb-10">
        <div className="flex items-center gap-4 mb-3">
          <div className="w-1 h-8 bg-gradient-to-b from-primary via-primary/60 to-transparent rounded-full" />
          <h2 className="text-2xl font-mono font-bold tracking-tight text-foreground">CollapsibleSidebar</h2>
        </div>
        <p className="text-sm font-mono text-muted-foreground ml-5 pl-4 border-l border-zinc-800/60">
          Layout wrapper with left/right border, configurable width, and collapse transition. Left variant has right
          border; right variant has left border. Collapsed: 48px, expanded: 280px.
        </p>
      </div>

      {/* Instrument cluster container */}
      <div className="relative rounded-xl bg-gradient-to-b from-zinc-900/60 to-zinc-950/80 border border-zinc-700/30 p-8 shadow-[0_4px_40px_-10px_rgba(0,0,0,0.5)]">
        <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="flex flex-col gap-3">
            <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">left expanded</span>
            <div className="h-[240px] border border-zinc-700/50 rounded-lg overflow-hidden flex shadow-[0_2px_20px_-5px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)]">
              <CollapsibleSidebar side="left" collapsed={false} onToggle={() => {}} expandedWidth="100%">
                <SidebarHeader icon={<Film className="w-4 h-4" />} title="CLIPS" collapsed={false} onToggle={() => {}} side="left" sortOrder="newest" onSortChange={() => {}} />
                <div className="flex-1 flex items-center justify-center">
                  <span className="font-mono text-[10px] text-muted-foreground/40">CARD_LIST</span>
                </div>
              </CollapsibleSidebar>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">left collapsed</span>
            <div className="h-[240px] border border-zinc-700/50 rounded-lg overflow-hidden flex shadow-[0_2px_20px_-5px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)]">
              <CollapsibleSidebar side="left" collapsed={true} onToggle={() => {}}>
                <SidebarHeader icon={<Film className="w-4 h-4" />} title="CLIPS" collapsed={true} onToggle={() => {}} side="left" />
              </CollapsibleSidebar>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">right expanded</span>
            <div className="h-[240px] border border-zinc-700/50 rounded-lg overflow-hidden flex justify-end shadow-[0_2px_20px_-5px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)]">
              <CollapsibleSidebar side="right" collapsed={false} onToggle={() => {}} expandedWidth="100%">
                <SidebarHeader icon={<AudioLines className="w-4 h-4" />} title="AUDIO" collapsed={false} onToggle={() => {}} side="right" />
                <div className="flex-1 flex items-center justify-center">
                  <span className="font-mono text-[10px] text-muted-foreground/40">CARD_LIST</span>
                </div>
              </CollapsibleSidebar>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">right collapsed</span>
            <div className="h-[240px] border border-zinc-700/50 rounded-lg overflow-hidden flex justify-end shadow-[0_2px_20px_-5px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)]">
              <CollapsibleSidebar side="right" collapsed={true} onToggle={() => {}}>
                <SidebarHeader icon={<AudioLines className="w-4 h-4" />} title="AUDIO" collapsed={true} onToggle={() => {}} side="right" />
              </CollapsibleSidebar>
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 left-12 right-12 h-px bg-gradient-to-r from-transparent via-zinc-700/30 to-transparent" />
      </div>
    </section>
  );
}

// ── Gen System ──

const genNoop = () => {};

const mockModelOptions: ModelOption[] = [
  {
    key: 'veo3_fast',
    label: 'Veo 3 Fast',
    tool_name: 'generate_veo_video',
    description: 'Fast video generation',
    schema: { type: 'object', properties: {}, required: [] },
    prefilled_values: {},
    validation: { valid: true, missing_required: [], warnings: [] },
  },
  {
    key: 'veo3',
    label: 'Veo 3',
    tool_name: 'generate_veo_video',
    description: 'High quality video generation',
    schema: { type: 'object', properties: {}, required: [] },
    prefilled_values: {},
    validation: { valid: true, missing_required: [], warnings: [] },
  },
  {
    key: 'nano_banana',
    label: 'Nano Banana',
    tool_name: 'generate_nano_banana_image',
    description: 'Image generation',
    schema: { type: 'object', properties: {}, required: [] },
    prefilled_values: {},
    validation: { valid: true, missing_required: [], warnings: [] },
  },
];

// ── ImageParamSlots mock data ──

const mockAssetFields = [
  { name: 'image_slugs', schema: { type: 'array' as const, items: { type: 'string' }, description: 'Image slugs' }, value: [], required: true },
];

const mockAssetFieldsFilled = [
  { name: 'image_slugs', schema: { type: 'array' as const, items: { type: 'string' }, description: 'Image slugs' }, value: ['@img-neon-fox'], required: true },
];

const mockVideoAssetFields = [
  { name: 'video_slug', schema: { type: 'string' as const, description: 'Video slug' }, value: '', required: true },
];

const mockResolvedAssets = [
  { slug: '@img-neon-fox', src: '/styleguide-img-neon-fox.jpg', type: 'image' as const },
  { slug: '@img-hero-banner', src: '/styleguide-img-cover.jpg', type: 'image' as const },
  { slug: '@img-cute-dog-1', src: '/styleguide-vid-purple-grind.jpg', type: 'image' as const },
  { slug: '@img-cute-dog-2', src: '/styleguide-vid-turret-cyber.jpg', type: 'image' as const },
  { slug: '@img-hero-front', src: '/styleguide-vid-sky-ghost.jpg', type: 'image' as const },
  { slug: '@img-hero-side', src: '/styleguide-img-neon-fox.jpg', type: 'image' as const },
  { slug: '@img-villain-mask', src: '/styleguide-final-thumb.jpg', type: 'image' as const },
];

// ── ElementGroupEditor mock data ──

const mockElementGroupIndices = [1, 2, 3];
const mockElementSchemas = new Map<string, JSONSchemaProperty>([
  ['element1_slugs', { type: 'array', items: { type: 'string' }, description: 'Element 1 slugs', maxItems: 4 }],
  ['element1_name', { type: 'string', description: 'Element 1 name' }],
  ['element1_desc', { type: 'string', description: 'Element 1 description' }],
  ['element2_slugs', { type: 'array', items: { type: 'string' }, description: 'Element 2 slugs', maxItems: 4 }],
  ['element2_name', { type: 'string', description: 'Element 2 name' }],
  ['element2_desc', { type: 'string', description: 'Element 2 description' }],
  ['element3_slugs', { type: 'array', items: { type: 'string' }, description: 'Element 3 slugs', maxItems: 4 }],
  ['element3_name', { type: 'string', description: 'Element 3 name' }],
  ['element3_desc', { type: 'string', description: 'Element 3 description' }],
]);
const mockElementFormEmpty: Record<string, unknown> = {};
const mockElementFormFilled: Record<string, unknown> = {
  element1_slugs: ['@img-cute-dog-1', '@img-cute-dog-2'],
  element1_name: '',
  element1_desc: 'A friendly golden retriever',
};
const mockElementFormMulti: Record<string, unknown> = {
  element1_slugs: ['@img-hero-front', '@img-hero-side'],
  element1_name: 'element_hero',
  element1_desc: 'Main character, confident stance',
  element2_slugs: ['@img-villain-mask'],
  element2_name: 'element_villain',
  element2_desc: 'Antagonist with dark cloak',
};
const mockElementFormPrefilledNoSlugs: Record<string, unknown> = {
  element1_name: 'element_hero',
  element1_desc: 'Main character from prompt history',
  element1_slugs: [],
  element2_name: 'element_sidekick',
  element2_desc: 'Comic relief companion',
  element2_slugs: [],
};

function GenSystemSection() {
  return (
    <section className="mb-24">
      {/* Commanding section header */}
      <div className="mb-14">
        <div className="flex items-center gap-4 mb-3">
          <div className="w-1.5 h-10 bg-gradient-to-b from-primary via-primary/60 to-transparent rounded-full shadow-[0_0_12px_rgba(0,255,255,0.3)]" />
          <h2 className="text-3xl font-mono font-bold tracking-tight text-foreground">Gen System</h2>
        </div>
        <p className="text-sm font-mono text-muted-foreground ml-6 pl-4 border-l border-zinc-800/60 max-w-3xl">
          Generation panel components: structural frames, form fields, execute button, asset drop slots, model selectors,
          image parameter slots, element group editors, and error states. These compose into the DynamicGen panel used for
          video and image generation.
        </p>
        {/* Wide gradient separator under main header */}
        <div className="mt-8 h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent" />
      </div>

      {/* GenFrame */}
      <div className="mb-12 pl-4 border-l-2 border-primary/20">
        <h3 className="text-lg font-mono font-bold mb-2 text-foreground/90 tracking-wide">GenFrame</h3>
        <p className="text-xs font-mono text-muted-foreground mb-5">
          Base container with CRT scanlines, pixel grid background, cyan border glow. All gen panels inherit this frame.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">bare frame</span>
          <div className="h-[220px]">
            <GenFrame>
              <div className="flex-1 flex items-center justify-center">
                <span className="font-mono text-xs text-primary/30">CONTENT_AREA</span>
              </div>
            </GenFrame>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">with header + footer</span>
          <div className="h-[220px]">
            <GenFrame
              header={
                <div className="flex items-center gap-2 px-3 py-2 border-b-2 border-inherit bg-black/50">
                  <span className="text-xs font-bold tracking-[0.15em] text-cyan-400">SAMPLE_HEADER</span>
                </div>
              }
              footer={
                <div className="shrink-0 p-2.5 border-t-2 border-inherit bg-black/30">
                  <span className="text-xs font-mono text-primary/40">FOOTER_AREA</span>
                </div>
              }
            >
              <div className="flex-1 flex items-center justify-center">
                <span className="font-mono text-xs text-primary/30">CONTENT_AREA</span>
              </div>
            </GenFrame>
          </div>
        </div>
      </div>

      {/* GenPanel */}
      <div className="mb-12 pl-4 border-l-2 border-primary/20">
        <h3 className="text-lg font-mono font-bold mb-2 text-foreground/90 tracking-wide">GenPanel</h3>
        <p className="text-xs font-mono text-muted-foreground mb-5">
          Complete panel: GenFrame + header (icon, label, close button) + optional footer. Used by DynamicGen for
          VIDEO_GENERATION and IMAGE_GENERATION.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">video panel</span>
          <div className="h-[240px]">
            <GenPanel
              label="VIDEO_GENERATION"
              icon={<Film className="w-5 h-5" />}
              onClose={genNoop}
              footer={
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-primary/40">FOOTER_SLOT</span>
                </div>
              }
            >
              <div className="flex-1 flex items-center justify-center">
                <span className="font-mono text-xs text-primary/30">FORM_FIELDS</span>
              </div>
            </GenPanel>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">
            image panel (close disabled)
          </span>
          <div className="h-[240px]">
            <GenPanel
              label="IMAGE_GENERATION"
              icon={<ImageIcon className="w-5 h-5" />}
              onClose={genNoop}
              closeDisabled={true}
              footer={
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-primary/40">FOOTER_SLOT</span>
                </div>
              }
            >
              <div className="flex-1 flex items-center justify-center">
                <span className="font-mono text-xs text-primary/30">FORM_FIELDS</span>
              </div>
            </GenPanel>
          </div>
        </div>
      </div>

      {/* Composed Panel Demo */}
      <div className="mb-8 mt-4">
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-700/40 to-transparent mb-12" />
        <div className="pl-4 border-l-2 border-primary/30">
          <h3 className="text-lg font-mono font-bold mb-2 text-foreground/90 tracking-wide">Composed Panel (Demo)</h3>
          <p className="text-xs font-mono text-muted-foreground mb-5">
            Full DynamicGen-style composition: GenPanel with model selector and execute button in footer, form fields in
            the body.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-8 mb-16">
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">
            video generation panel
          </span>
          <div className="h-[420px] max-w-3xl">
            <GenPanel
              label="VIDEO_GENERATION"
              icon={<Film className="w-5 h-5" />}
              onClose={genNoop}
              footer={
                <div className="flex items-center gap-4">
                  <ModelSelector selectedModelKey="veo3_fast" modelOptions={mockModelOptions} onChange={genNoop} />
                  <div className="flex-1" />
                  <div className="w-48">
                    <ExecuteButton state="ready" onClick={genNoop} />
                  </div>
                </div>
              }
            >
              <div className="flex-1 pl-4 pr-8 py-4 overflow-y-auto">
                <div className="space-y-6">
                  <GenField
                    label="Prompt"
                    required
                    actions={
                      <button className="h-5 px-1.5 font-bold text-[10px] tracking-wider shrink-0 rounded border bg-primary/20 border-primary/40 text-primary hover:bg-primary/30 hover:border-primary/60 shadow-[0_0_8px_rgba(0,255,255,0.3)] transition-all duration-200 flex items-center justify-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        <span>Rewrite</span>
                      </button>
                    }
                  >
                    <GenTextarea
                      value="A cinematic drone shot sweeping over a coastal city at golden hour, with reflections of sunlight dancing on the water surface"
                      onChange={genNoop}
                      rows={4}
                    />
                  </GenField>
                  <div className="flex flex-wrap gap-x-6 gap-y-4">
                    <GenField label="Aspect Ratio">
                      <GenToggle value="16:9" onChange={genNoop} options={['16:9', '9:16'] as const} />
                    </GenField>
                    <GenField label="Duration">
                      <GenToggle value="8" onChange={genNoop} options={['5', '8', '10'] as const} />
                    </GenField>
                    <GenField label="Model">
                      <GenToggle value="veo3_fast" onChange={genNoop} options={['veo3_fast', 'veo3'] as const} />
                    </GenField>
                  </div>
                </div>
              </div>
            </GenPanel>
          </div>
        </div>
      </div>

      {/* ImageParamSlots */}
      <div className="h-px bg-gradient-to-r from-transparent via-zinc-700/40 to-transparent mb-12" />
      <div className="mb-12 pl-4 border-l-2 border-primary/20">
        <h3 className="text-lg font-mono font-bold mb-2 text-foreground/90 tracking-wide">ImageParamSlots</h3>
        <p className="text-xs font-mono text-muted-foreground mb-5">
          Asset slot panel for image/video parameters. Shows slot count indicator, required badges, and manages add/remove
          of asset references. Used in the DynamicGen sidebar.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-8 mb-16">
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">empty (1 required)</span>
          <div className="w-[190px] border border-primary/20 rounded-lg bg-black/30 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ImageParamSlots assetFields={mockAssetFields} imageSlots={{ min: 1, max: 2 }} onChange={genNoop} />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">filled (1 of 2)</span>
          <div className="w-[190px] border border-primary/20 rounded-lg bg-black/30 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ImageParamSlots assetFields={mockAssetFieldsFilled} imageSlots={{ min: 1, max: 2 }} onChange={genNoop} resolvedAssets={mockResolvedAssets} />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">disabled</span>
          <div className="w-[190px] border border-primary/20 rounded-lg bg-black/30 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ImageParamSlots
              assetFields={mockAssetFields}
              imageSlots={{ min: 0, max: 1 }}
              onChange={genNoop}
              disabled
            />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">video mode</span>
          <div className="w-[190px] border border-primary/20 rounded-lg bg-black/30 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ImageParamSlots assetFields={mockVideoAssetFields} imageSlots={{ min: 1, max: 1 }} onChange={genNoop} />
          </div>
        </div>
      </div>

      {/* ElementGroupEditor */}
      <div className="h-px bg-gradient-to-r from-transparent via-zinc-700/40 to-transparent mb-12" />
      <div className="mb-12 pl-4 border-l-2 border-primary/20">
        <h3 className="text-lg font-mono font-bold mb-2 text-foreground/90 tracking-wide">ElementGroupEditor</h3>
        <p className="text-xs font-mono text-muted-foreground mb-5">
          Violet-accented inline element groups with asset drop slots, name, and description fields. Each group represents
          a named character/object reference. Groups are added progressively and show name/desc fields when slugs are
          populated or when name/desc values are prefilled (e.g. from prompt history).
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 mb-16">
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">empty (add button)</span>
          <div className="max-w-md border border-zinc-700/40 rounded-lg bg-black/30 p-4 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ElementGroupEditor
              elementGroupIndices={mockElementGroupIndices}
              elementSchemas={mockElementSchemas}
              formValues={mockElementFormEmpty}
              assets={[]}
              onChange={genNoop}
            />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">
            1 group filled (with name/desc)
          </span>
          <div className="max-w-md border border-zinc-700/40 rounded-lg bg-black/30 p-4 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ElementGroupEditor
              elementGroupIndices={mockElementGroupIndices}
              elementSchemas={mockElementSchemas}
              formValues={mockElementFormFilled}
              resolvedAssets={mockResolvedAssets}
              assets={[]}
              onChange={genNoop}
            />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">2 groups filled</span>
          <div className="max-w-md border border-zinc-700/40 rounded-lg bg-black/30 p-4 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ElementGroupEditor
              elementGroupIndices={mockElementGroupIndices}
              elementSchemas={mockElementSchemas}
              formValues={mockElementFormMulti}
              resolvedAssets={mockResolvedAssets}
              assets={[]}
              onChange={genNoop}
            />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">
            prefilled name/desc (no slugs)
          </span>
          <div className="max-w-md border border-zinc-700/40 rounded-lg bg-black/30 p-4 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ElementGroupEditor
              elementGroupIndices={mockElementGroupIndices}
              elementSchemas={mockElementSchemas}
              formValues={mockElementFormPrefilledNoSlugs}
              assets={[]}
              onChange={genNoop}
            />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">disabled</span>
          <div className="max-w-md border border-zinc-700/40 rounded-lg bg-black/30 p-4 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ElementGroupEditor
              elementGroupIndices={mockElementGroupIndices}
              elementSchemas={mockElementSchemas}
              formValues={mockElementFormFilled}
              resolvedAssets={mockResolvedAssets}
              assets={[]}
              onChange={genNoop}
              disabled
            />
          </div>
        </div>
      </div>

      {/* ErrorPage */}
      <div className="h-px bg-gradient-to-r from-transparent via-zinc-700/40 to-transparent mb-12" />
      <div className="mb-12 pl-4 border-l-2 border-primary/20">
        <h3 className="text-lg font-mono font-bold mb-2 text-foreground/90 tracking-wide">ErrorPage</h3>
        <p className="text-xs font-mono text-muted-foreground mb-5">
          Fallback shown when no model options are available. AlertCircle icon + message.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">default message</span>
          <div className="h-[120px] border border-zinc-700/40 rounded-lg overflow-hidden bg-black/40 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ErrorPage />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-mono text-primary/60 uppercase tracking-[0.15em] font-bold">custom message</span>
          <div className="h-[120px] border border-zinc-700/40 rounded-lg overflow-hidden bg-black/40 shadow-[0_2px_15px_-5px_rgba(0,0,0,0.4)]">
            <ErrorPage message="Model configuration error: missing API key" />
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Pending Generations Section ──

const pendingGenButtonStates: { label: string; state: GenerationState; generatingCount: number; readyCount: number }[] = [
  { label: 'inactive', state: 'inactive', generatingCount: 0, readyCount: 0 },
  { label: 'generating', state: 'generating', generatingCount: 3, readyCount: 0 },
  { label: 'ready', state: 'ready', generatingCount: 0, readyCount: 4 },
  { label: 'ready + generating', state: 'ready', generatingCount: 2, readyCount: 3 },
];

const mockReadyVideos: MediaItem[] = [
  { id: 'rv-1', type: 'video', slug: '@hero-intro', title: 'Hero Intro', filePath: '/styleguide-vid-purple-grind.jpg', status: 'ready', durationSeconds: 8, origin: 'veo3', thumbnailSrc: '/styleguide-vid-purple-grind.jpg' },
  { id: 'rv-2', type: 'video', slug: '@product-shot', title: 'Product Shot', filePath: '/styleguide-vid-turret-cyber.jpg', status: 'ready', durationSeconds: 5, origin: 'kling3', thumbnailSrc: '/styleguide-vid-turret-cyber.jpg' },
  { id: 'rv-3', type: 'video', slug: '@sky-ghost', title: 'Sky Ghost', filePath: '/styleguide-vid-sky-ghost.jpg', status: 'ready', durationSeconds: 10, origin: 'wan21', thumbnailSrc: '/styleguide-vid-sky-ghost.jpg' },
];

const mockPendingVideos: MediaItem[] = [
  { id: 'pv-1', type: 'video', slug: '@drone-flyover', title: 'Drone Flyover', filePath: '', status: 'generating', durationSeconds: null, origin: 'veo3', thumbnailSrc: null },
  { id: 'pv-2', type: 'video', slug: '@neon-walk', title: 'Neon Walk', filePath: '', status: 'downloading', durationSeconds: null, origin: 'kling3', thumbnailSrc: null },
];

function PendingGenerationsSection() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  const [drawerVideos, setDrawerVideos] = useState(mockReadyVideos);
  const [drawerPending, setDrawerPending] = useState(mockPendingVideos);

  const handleApprove = useCallback((video: MediaItem) => {
    setDrawerVideos((prev) => prev.filter((v) => v.id !== video.id));
  }, []);

  const handleReject = useCallback((video: MediaItem) => {
    setDrawerVideos((prev) => prev.filter((v) => v.id !== video.id));
  }, []);

  const resetDrawer = useCallback(() => {
    setDrawerVideos(mockReadyVideos);
    setDrawerPending(mockPendingVideos);
  }, []);

  return (
    <section className="relative mb-20 bg-gradient-to-b from-black/50 to-zinc-950/30 border border-cyan-500/15 rounded-xl p-10 shadow-[0_0_50px_-10px_rgba(0,212,255,0.1)] overflow-hidden">
      {/* Scan-line overlay */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.025] bg-[repeating-linear-gradient(0deg,transparent,transparent_3px,rgba(0,212,255,0.3)_3px,rgba(0,212,255,0.3)_4px)]" />
      {/* Corner accents */}
      <div className="absolute top-0 left-0 w-12 h-12 border-t-2 border-l-2 border-cyan-500/25 rounded-tl-xl" />
      <div className="absolute top-0 right-0 w-12 h-12 border-t-2 border-r-2 border-cyan-500/25 rounded-tr-xl" />
      <div className="absolute bottom-0 left-0 w-12 h-12 border-b-2 border-l-2 border-cyan-500/25 rounded-bl-xl" />
      <div className="absolute bottom-0 right-0 w-12 h-12 border-b-2 border-r-2 border-cyan-500/25 rounded-br-xl" />

      <div className="relative mb-8">
        <h2 className="text-2xl font-mono font-bold tracking-[0.15em] uppercase text-cyan-400 pb-4" style={{ textShadow: '0 0 25px rgba(0,212,255,0.5), 0 0 50px rgba(0,212,255,0.15)' }}>Pending Generations</h2>
        <div className="h-px bg-gradient-to-r from-cyan-500/50 via-cyan-500/15 to-transparent" />
      </div>
      <p className="relative text-xs font-mono text-muted-foreground mb-8">
        Review queue for AI-generated videos. Button shows generation state with flash animation on incoming.
        Drawer opens full-screen with approve/reject per tile, pending incoming strip, and all-clear auto-close.
      </p>

      {/* PendingGenerationsButton states */}
      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>PendingGenerationsButton</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Four states: inactive (muted), generating (amber pulse), ready (amber glow), ready + generating (split badge).
        Click "Flash" to trigger the burst animation on the ready button.
      </p>
      <div className="relative flex flex-wrap items-end gap-6 mb-10 bg-black/20 border border-cyan-900/15 rounded-lg p-6">
        {pendingGenButtonStates.map((s) => (
          <div key={s.label} className="flex flex-col items-center gap-2">
            <PendingGenerationsButton
              state={s.state}
              generatingCount={s.generatingCount}
              readyCount={s.readyCount}
              flashKey={s.state === 'ready' ? flashKey : 0}
              onClick={() => {}}
            />
            <span className="text-[10px] font-mono text-muted-foreground">{s.label}</span>
          </div>
        ))}
        <button
          onClick={() => setFlashKey((k) => k + 1)}
          className="text-[10px] font-mono font-bold tracking-wider text-primary/60 border border-primary/30 rounded px-2 py-1 hover:bg-primary/10 transition-colors"
        >
          FLASH
        </button>
      </div>

      {/* Drawer demo */}
      {/* Neon divider */}
      <div className="relative h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent mb-2" />

      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>PendingGenerationsDrawer</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Full-screen review overlay. Active tile highlighted with cyan glow. Approve/reject removes tiles with
        spring animation. Pending section shows incoming generations. All-clear state auto-closes after 1.5s.
      </p>
      <div className="relative flex items-center gap-3 mb-10">
        <button
          onClick={() => { resetDrawer(); setDrawerOpen(true); }}
          className="text-xs font-mono font-bold tracking-wider text-primary border border-primary/40 rounded px-3 py-1.5 hover:bg-primary/10 transition-colors"
        >
          OPEN DRAWER (3 ready + 2 pending)
        </button>
        <button
          onClick={() => { setDrawerVideos([]); setDrawerPending([]); setDrawerOpen(true); }}
          className="text-xs font-mono font-bold tracking-wider text-primary/60 border border-primary/20 rounded px-3 py-1.5 hover:bg-primary/10 transition-colors"
        >
          OPEN EMPTY (all-clear)
        </button>
      </div>

      {/* Inline preview: ReviewTile + PendingSection anatomy */}
      {/* Neon divider */}
      <div className="relative h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent mb-2" />

      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>Anatomy (inline preview)</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Review tile with metadata strip and action buttons. Active tile has cyan border glow; inactive tiles are dimmed.
      </p>
      <div className="relative grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6 max-w-4xl mb-10">
        {/* Active tile mock */}
        <div className="rounded-lg border border-primary/60 bg-card/95 shadow-[0_0_15px_rgba(0,255,255,0.15)] overflow-hidden flex flex-col">
          <div className="aspect-video bg-black relative">
            <img src="/styleguide-vid-purple-grind.jpg" alt="" className="w-full h-full object-cover" />
          </div>
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-muted-foreground mt-auto">
            <span className="text-primary/70 truncate">@hero-intro</span>
            <span className="text-border">&middot;</span>
            <span className="shrink-0">0:08</span>
            <span className="text-border">&middot;</span>
            <span className="shrink-0">veo3</span>
          </div>
          <div className="flex border-t border-border/50">
            <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-red-400 border-r border-border/50">
              <X className="w-3.5 h-3.5" /> REJECT
            </div>
            <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-primary">
              <Check className="w-3.5 h-3.5" /> APPROVE
            </div>
          </div>
        </div>

        {/* Inactive tile mock */}
        <div className="rounded-lg border border-border/20 bg-card/60 opacity-60 overflow-hidden flex flex-col">
          <div className="aspect-video bg-black relative cursor-pointer">
            <img src="/styleguide-vid-turret-cyber.jpg" alt="" className="w-full h-full object-cover" />
          </div>
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-muted-foreground mt-auto">
            <span className="text-primary/70 truncate">@product-shot</span>
            <span className="text-border">&middot;</span>
            <span className="shrink-0">0:05</span>
            <span className="text-border">&middot;</span>
            <span className="shrink-0">kling3</span>
          </div>
          <div className="flex border-t border-border/50">
            <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-red-400 border-r border-border/50">
              <X className="w-3.5 h-3.5" /> REJECT
            </div>
            <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-primary">
              <Check className="w-3.5 h-3.5" /> APPROVE
            </div>
          </div>
        </div>

        {/* Mutating tile mock */}
        <div className="rounded-lg border border-border/20 bg-card/60 overflow-hidden flex flex-col">
          <div className="aspect-video bg-black relative">
            <img src="/styleguide-vid-sky-ghost.jpg" alt="" className="w-full h-full object-cover opacity-50" />
          </div>
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-muted-foreground mt-auto">
            <span className="text-primary/70 truncate">@sky-ghost</span>
            <span className="text-border">&middot;</span>
            <span className="shrink-0">0:10</span>
            <span className="text-border">&middot;</span>
            <span className="shrink-0">wan21</span>
          </div>
          <div className="flex border-t border-border/50">
            <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-red-400/50 border-r border-border/50">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> REJECT
            </div>
            <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-primary/50">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> APPROVE
            </div>
          </div>
        </div>
      </div>

      {/* Pending strip preview */}
      {/* Neon divider */}
      <div className="relative h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent mb-2" />

      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>Pending Strip</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Bottom bar showing in-flight generation jobs with status tags (GEN, DL).
      </p>
      <div className="relative max-w-2xl border border-cyan-900/30 rounded-lg overflow-hidden bg-zinc-950/80 mb-10 shadow-[0_0_20px_-5px_rgba(0,212,255,0.06)]">
        <div className="border-t border-border/50">
          <div className="flex items-center gap-2 px-6 py-2">
            <span className="text-[10px] font-mono font-bold tracking-widest text-amber-500/70 uppercase">INCOMING</span>
            <span className="text-[10px] font-mono text-muted-foreground">3</span>
          </div>
          <div className="max-h-32 overflow-y-auto px-6 pb-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {[
              { slug: '@drone-flyover', status: 'GEN' },
              { slug: '@neon-walk', status: 'DL' },
              { slug: '@sunset-pan', status: 'GEN' },
            ].map((v) => (
              <div key={v.slug} className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin text-amber-500/60 shrink-0" />
                <span className="truncate text-foreground/70">{v.slug}</span>
                <span className="text-[10px] bg-amber-500/15 text-amber-500/70 px-1.5 rounded shrink-0">{v.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* All Clear state preview */}
      {/* Neon divider */}
      <div className="relative h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent mb-2" />

      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>All Clear State</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Shown when all videos are processed. Auto-closes the drawer after 1.5 seconds.
      </p>
      <div className="relative max-w-sm border border-cyan-500/20 rounded-lg overflow-hidden bg-zinc-950/80 py-8 shadow-[0_0_25px_-5px_rgba(0,212,255,0.08)]">
        <div className="flex flex-col items-center justify-center py-6 px-6">
          <CheckCircle2 className="w-12 h-12 text-primary mb-3" />
          <span className="text-sm font-mono font-bold tracking-widest text-primary uppercase">ALL_CLEAR</span>
        </div>
      </div>

      <PendingGenerationsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        videos={drawerVideos}
        pendingVideos={drawerPending}
        onApprove={handleApprove}
        onReject={handleReject}
      />
    </section>
  );
}

// ── Chat & Messaging Section ──

const sampleScript = `INT. NEON ALLEY - NIGHT

A figure in a long coat walks through rain-slicked streets. Holographic advertisements flicker overhead, casting cyan light across wet pavement.

NARRATOR (V.O.)
In the year 2087, the line between human and machine had blurred beyond recognition.

The figure stops, looking up at a massive screen displaying a countdown timer.

NARRATOR (V.O.)
But some things never change. The need to create. To tell stories. To be heard.`;

function ChatMessagingSection() {
  const [transmissionKey, setTransmissionKey] = useState(0);
  const [transmissionRunning, setTransmissionRunning] = useState(false);

  // ProofReadButton demo state
  const dummyAudioRef = useRef<HTMLAudioElement>(null);

  // ScriptBlock demo
  const [scriptContent, setScriptContent] = useState(sampleScript);
  const [scriptOriginal] = useState(sampleScript);
  const scriptHasChanges = scriptContent !== scriptOriginal;

  const replayTransmission = useCallback(() => {
    setTransmissionRunning(false);
    setTransmissionKey((k) => k + 1);
    // small delay so React unmounts then remounts
    setTimeout(() => setTransmissionRunning(true), 50);
  }, []);

  return (
    <section className="relative mb-20 bg-gradient-to-b from-black/60 to-zinc-950/40 border border-cyan-900/30 rounded-xl p-10 shadow-[0_0_50px_-10px_rgba(0,212,255,0.08)] overflow-hidden">
      {/* Scan-line overlay */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.02] bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(0,212,255,0.5)_2px,rgba(0,212,255,0.5)_3px)]" />
      {/* Corner brackets */}
      <div className="absolute top-0 left-0 w-14 h-14 border-t-2 border-l-2 border-cyan-500/20 rounded-tl-xl" />
      <div className="absolute top-0 right-0 w-14 h-14 border-t-2 border-r-2 border-cyan-500/20 rounded-tr-xl" />
      <div className="absolute bottom-0 left-0 w-14 h-14 border-b-2 border-l-2 border-cyan-500/20 rounded-bl-xl" />
      <div className="absolute bottom-0 right-0 w-14 h-14 border-b-2 border-r-2 border-cyan-500/20 rounded-br-xl" />

      <div className="relative mb-8">
        <h2 className="text-2xl font-mono font-bold tracking-[0.15em] uppercase pb-4" style={{ textShadow: '0 0 25px rgba(0,212,255,0.5), 0 0 50px rgba(0,212,255,0.15)' }}>
          <span className="text-cyan-400">Chat</span> <span className="text-cyan-600/50">&amp;</span> <span className="text-cyan-400">Messaging</span>
        </h2>
        <div className="h-px bg-gradient-to-r from-cyan-500/50 via-cyan-500/15 to-transparent" />
      </div>
      <p className="relative text-xs font-mono text-muted-foreground mb-8">
        Terminal-style input with @ autocomplete, transmission confirmation animation, and full script viewer/editor with proof-read audio.
      </p>

      {/* ── ChatInput States ── */}
      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>ChatInput</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Terminal prompt with @ autocomplete for asset slugs. Type @ to see the dropdown. Supports keyboard navigation (arrows, tab, enter, escape).
      </p>
      <div className="relative space-y-5 max-w-2xl mb-10 bg-black/20 border border-cyan-900/15 rounded-lg p-6">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">default</span>
          <ChatInput assetSlugs={['@hero-intro', '@product-shot', '@bg-neon', '@outro-final', '@clip-dance']} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">loading</span>
          <ChatInput isLoading assetSlugs={[]} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">transmitting</span>
          <ChatInput isTransmitting assetSlugs={[]} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">disabled</span>
          <ChatInput disabled assetSlugs={[]} />
        </div>
      </div>

      {/* Neon divider */}
      <div className="relative h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent mb-2" />

      {/* ── TransmissionSequence ── */}
      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>TransmissionSequence</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Cinematic confirmation animation: scan line sweep, typewriter &ldquo;TRANSMISSION_RECEIVED&rdquo;, message echo, then dissolve. Plays once and calls onComplete.
      </p>
      <div className="mb-3">
        <button
          onClick={replayTransmission}
          className="text-xs font-mono font-bold tracking-wider text-primary border border-primary/40 rounded px-3 py-1.5 hover:bg-primary/10 transition-colors"
        >
          REPLAY
        </button>
      </div>
      <div className="relative h-48 max-w-2xl border border-cyan-900/30 rounded-lg overflow-hidden bg-black/80 mb-10 shadow-[0_0_20px_-5px_rgba(0,212,255,0.06)]">
        {transmissionRunning && (
          <TransmissionSequence
            key={transmissionKey}
            message="gen cinematic drone shot of neon alley at night, rain-slicked streets"
            onComplete={() => setTransmissionRunning(false)}
          />
        )}
        {!transmissionRunning && (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xs font-mono text-muted-foreground/40">Click REPLAY to trigger animation</span>
          </div>
        )}
      </div>

      {/* Neon divider */}
      <div className="relative h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent mb-2" />

      {/* ── ProofReadButton States ── */}
      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>ProofReadButton</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Five states derived from audio URL, playback, pending, and dirty flags. Cycles between initial, pending, play, playing, and dirty (regenerate).
      </p>
      <div className="relative flex flex-wrap items-end gap-6 mb-10 bg-black/20 border border-cyan-900/15 rounded-lg p-6">
        {([
          { label: 'Initial', audioUrl: null, isPlaying: false, isPending: false, dialogDirty: false },
          { label: 'Pending', audioUrl: null, isPlaying: false, isPending: true, dialogDirty: false },
          { label: 'Play', audioUrl: '/fake.mp3', isPlaying: false, isPending: false, dialogDirty: false },
          { label: 'Playing', audioUrl: '/fake.mp3', isPlaying: true, isPending: false, dialogDirty: false },
          { label: 'Dirty', audioUrl: '/fake.mp3', isPlaying: false, isPending: false, dialogDirty: true },
        ] as const).map((s) => (
          <div key={s.label} className="flex flex-col items-center gap-2">
            <ProofReadButton
              audioUrl={s.audioUrl}
              isPlaying={s.isPlaying}
              isPending={s.isPending}
              dialogDirty={s.dialogDirty}
              disabled={false}
              onPlay={() => {}}
              onRegenerate={() => {}}
              audioRef={dummyAudioRef}
            />
            <span className="text-[10px] font-mono text-muted-foreground">{s.label}</span>
          </div>
        ))}
        <div key="disabled" className="flex flex-col items-center gap-2">
          <ProofReadButton
            audioUrl={null}
            isPlaying={false}
            isPending={false}
            dialogDirty={false}
            disabled={true}
            onPlay={() => {}}
            onRegenerate={() => {}}
            audioRef={dummyAudioRef}
          />
          <span className="text-[10px] font-mono text-muted-foreground">Disabled</span>
        </div>
      </div>

      {/* Neon divider */}
      <div className="relative h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent mb-2" />

      {/* ── ScriptBlock (editable text block) ── */}
      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>ScriptBlock</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Labeled editable text block with save/cancel controls. Click the text to enter edit mode. Edit the text to reveal save/cancel buttons.
      </p>
      <div className="relative max-w-2xl mb-10">
        <ScriptBlock
          label="Script"
          content={scriptContent}
          onChange={setScriptContent}
          onSave={() => {}}
          onCancel={() => setScriptContent(scriptOriginal)}
          hasChanges={scriptHasChanges}
          isSaving={false}
          placeholder="Enter script content..."
        />
      </div>

      {/* Neon divider */}
      <div className="relative h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent mb-2" />

      {/* ── ScriptReadout (full component) ── */}
      <h3 className="relative text-sm font-mono font-bold mb-4 text-cyan-400/80" style={{ textShadow: '0 0 12px rgba(0,212,255,0.3)' }}>ScriptReadout</h3>
      <p className="relative text-xs font-mono text-muted-foreground mb-4">
        Full script viewer/editor with scanline overlay, pixel grid, corner accents, header with slug + Gen Video button,
        and editable body with proof-read audio controls. Click the script text to edit.
      </p>
      <div className="relative grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
        {/* With content */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">with content</span>
          <div className="h-[400px]">
            <ScriptReadout
              content={sampleScript}
              slug="@hero-script"
              onSave={() => {}}
              onGenerateVideo={() => {}}
              onProofRead={() => {}}
            />
          </div>
        </div>

        {/* Empty state */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">empty (no content)</span>
          <div className="h-[400px]">
            <ScriptReadout
              content={null}
              slug="@empty-script"
            />
          </div>
        </div>
      </div>

      {/* Generating state */}
      <div className="flex flex-col gap-2 max-w-lg">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">generating video</span>
        <div className="h-[400px]">
          <ScriptReadout
            content={sampleScript}
            slug="@rendering-script"
            isGenerating={true}
            onSave={() => {}}
            onGenerateVideo={() => {}}
            onProofRead={() => {}}
          />
        </div>
      </div>
    </section>
  );
}

// ── Main Styleguide ──

export function Styleguide() {
  return (
    <div className="min-h-screen pt-8 px-8 pb-12 space-y-14">
      <Toaster />
      <header className="space-y-3">
        <h1 className="text-3xl font-mono font-bold tracking-[0.15em]"><span className="text-foreground">CLIP</span><span className="text-primary">FIRST</span> <span className="text-primary/80 font-semibold">STYLE GUIDE</span></h1>
        <p className="text-muted-foreground font-mono text-sm leading-relaxed">
          Media cards, overlays, and center-stage views in all states
        </p>
      </header>

      {/* App Layout Demo */}
      <AppLayoutDemo />

      {/* ── COMPONENT CATALOG MEGA-DIVIDER ── */}
      <div className="relative py-16 -mx-8 px-8 mt-20 mb-8 border-y-2 border-primary/40 bg-gradient-to-r from-primary/[0.06] via-transparent to-primary/[0.06]">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--color-primary)/0.08,transparent_70%)]" />
        <div className="relative flex items-center gap-6">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
          <h2 className="text-4xl font-bold text-primary font-mono tracking-[0.2em] uppercase drop-shadow-[0_0_20px_var(--color-primary)] whitespace-nowrap">Component Catalog</h2>
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
        </div>
      </div>

      {/* Header / Nav Bar */}
      <section className="space-y-8">
        <div className="flex items-center gap-4">
          <div className="w-1.5 h-8 bg-primary rounded-full shadow-[0_0_12px_var(--color-primary)]" />
          <h2 className="text-2xl font-mono font-bold text-foreground tracking-wide uppercase">Header / Nav Bar</h2>
        </div>
        <div className="rounded-xl border-2 border-border/60 overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.4)]">
          <HeaderBar />
        </div>
      </section>

      {/* Colors + Typography -- dramatic row */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-16 p-10 -mx-8 bg-gradient-to-b from-card/50 to-transparent border-y border-border/30">
        {/* Colors */}
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <div className="w-1.5 h-8 bg-primary rounded-full shadow-[0_0_12px_var(--color-primary)]" />
            <h2 className="text-2xl font-mono font-bold text-foreground tracking-wide uppercase">Colors</h2>
          </div>
          <div className="grid grid-cols-4 gap-5">
            {colors.map((c) => (
              <div key={c.name} className="space-y-2.5 group">
                <div className={`${c.bg} rounded-lg h-20 border-2 border-border/40 shadow-lg transition-transform group-hover:scale-105`} />
                <p className="text-sm font-bold leading-tight tracking-wide">{c.name}</p>
                <p className="text-xs font-mono text-muted-foreground/80 leading-tight">{c.hex}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Typography */}
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <div className="w-1.5 h-8 bg-primary rounded-full shadow-[0_0_12px_var(--color-primary)]" />
            <h2 className="text-2xl font-mono font-bold text-foreground tracking-wide uppercase">Typography</h2>
          </div>
          <div className="space-y-5">
            <div className="pb-4 border-b border-border/20">
              <p className="text-3xl font-bold">Rajdhani Bold</p>
              <p className="text-xs font-mono text-muted-foreground/50 mt-1">font-bold / 700</p>
            </div>
            <div className="pb-4 border-b border-border/20">
              <p className="text-2xl font-semibold">Rajdhani Semibold</p>
              <p className="text-xs font-mono text-muted-foreground/50 mt-1">font-semibold / 600</p>
            </div>
            <div className="pb-4 border-b border-border/20">
              <p className="text-xl font-normal">Rajdhani Regular</p>
              <p className="text-xs font-mono text-muted-foreground/50 mt-1">font-normal / 400</p>
            </div>
            <div className="pb-4 border-b border-border/20">
              <p className="text-xl font-light text-foreground/70">Rajdhani Light</p>
              <p className="text-xs font-mono text-muted-foreground/50 mt-1">font-light / 300</p>
            </div>
            <div className="pb-4 border-b border-border/20">
              <p className="font-mono text-lg tracking-wide">JetBrains Mono -- 0123456789</p>
              <p className="text-xs font-mono text-muted-foreground/50 mt-1">monospace / code</p>
            </div>
            <div>
              <p className="font-mono text-sm text-primary/70 tracking-wide">const x = await fetchData();</p>
              <p className="text-xs font-mono text-muted-foreground/50 mt-1">monospace / inline code</p>
            </div>
          </div>
        </div>
      </section>

      {/* ==================== MEDIA CARD SECTIONS ==================== */}

      {/* Cards -- unique overlays */}
      <section className="space-y-8 p-10 -mx-8 bg-card/20 border-y border-border/20">
        <div className="flex items-center gap-4">
          <div className="w-1.5 h-8 bg-primary rounded-full shadow-[0_0_12px_var(--color-primary)]" />
          <h2 className="text-2xl font-mono font-bold text-foreground tracking-wide uppercase">Cards</h2>
        </div>
        <div className="flex flex-wrap gap-6">
          <div className="w-[200px]"><ReceivingGhostCard filename="hero-intro-final.mp4" /></div>
          <div className="w-[200px]"><PlanCard item={{ id: 'plan-ready-empty', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready' }} /></div>
          <div className="w-[200px]"><PlanCard item={{ id: 'plan-ready-text', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready', prompt: 'Scene 1: Wide establishing shot of the city skyline at golden hour. Camera slowly pans right to reveal the protagonist standing on a rooftop.\n\nScene 2: Close-up of hands typing on a laptop. Cut to screen showing data visualization.\n\nScene 3: Interview segment with soft key light.' }} /></div>
          {cardOverlayMocks.map(({ item, Component }) => (
            <div key={item.id} className="w-[200px]"><Component item={item} /></div>
          ))}
        </div>
      </section>

      {/* ==================== FORMS & CONTROLS ==================== */}

      <section className="relative bg-black/40 border border-cyan-500/20 rounded-xl p-10 space-y-14 shadow-[0_0_40px_-8px_rgba(0,212,255,0.12)] overflow-hidden">
        {/* Scan-line overlay */}
        <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(0,212,255,0.4)_2px,rgba(0,212,255,0.4)_4px)]" />
        {/* Corner accents */}
        <div className="absolute top-0 left-0 w-16 h-16 border-t-2 border-l-2 border-cyan-500/30 rounded-tl-xl" />
        <div className="absolute top-0 right-0 w-16 h-16 border-t-2 border-r-2 border-cyan-500/30 rounded-tr-xl" />
        <div className="absolute bottom-0 left-0 w-16 h-16 border-b-2 border-l-2 border-cyan-500/30 rounded-bl-xl" />
        <div className="absolute bottom-0 right-0 w-16 h-16 border-b-2 border-r-2 border-cyan-500/30 rounded-br-xl" />

        <div className="relative">
          <h2 className="text-2xl font-mono font-bold tracking-[0.15em] uppercase pb-4 mb-2" style={{ textShadow: '0 0 20px rgba(0,212,255,0.5), 0 0 40px rgba(0,212,255,0.2)' }}>
            <span className="text-cyan-400">Forms</span> <span className="text-cyan-600/60">&amp;</span> <span className="text-cyan-400">Controls</span>
          </h2>
          <div className="h-px bg-gradient-to-r from-cyan-500/60 via-cyan-500/20 to-transparent" />
        </div>

        {/* Row 1 — 3-column grid */}
        <div className="relative grid grid-cols-1 md:grid-cols-3 gap-12">
          {/* Overlays & Menus */}
          <div className="space-y-5 bg-black/20 border border-cyan-900/20 rounded-lg p-5">
            <h3 className="text-xs font-mono font-bold text-cyan-400/70 uppercase tracking-[0.15em] border-b border-cyan-500/20 pb-3" style={{ textShadow: '0 0 10px rgba(0,212,255,0.3)' }}>Overlays &amp; Menus</h3>
            <div className="flex flex-wrap gap-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>System Diagnostic</DialogTitle>
                  </DialogHeader>
                  <p className="text-sm text-muted-foreground">All subsystems nominal. Neural link integrity at 98.7%.</p>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline" size="sm">Dismiss</Button>
                    </DialogClose>
                    <Button size="sm">Confirm</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Settings className="w-3.5 h-3.5 mr-1.5" />
                    Dropdown
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Actions</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem><User className="w-3.5 h-3.5" /> Profile</DropdownMenuItem>
                  <DropdownMenuItem><Settings className="w-3.5 h-3.5" /> Settings</DropdownMenuItem>
                  <DropdownMenuItem><Bell className="w-3.5 h-3.5" /> Notifications</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive"><LogOut className="w-3.5 h-3.5" /> Logout</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Info className="w-3.5 h-3.5 mr-1.5" />
                    Popover
                  </Button>
                </PopoverTrigger>
                <PopoverContent>
                  <div className="space-y-2">
                    <h4 className="text-sm font-mono font-bold text-primary">System Info</h4>
                    <p className="text-xs text-muted-foreground">Renderer: WebGPU v2.1<br />Uptime: 47h 23m<br />Memory: 12.4 GB / 16 GB</p>
                  </div>
                </PopoverContent>
              </Popover>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="sm">Tooltip</Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Neural interface ready</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <Button
                variant="outline"
                size="sm"
                onClick={() => toast({ title: 'TRANSMISSION RECEIVED', description: 'Asset uploaded successfully.' })}
              >
                Toast
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => toast({ title: 'SYSTEM ERROR', description: 'Neural link interrupted.', variant: 'destructive' })}
              >
                Toast Error
              </Button>
              <Button variant="dashed" size="sm" className="text-foreground">
                <Upload className="w-3.5 h-3.5" />
                UPLOAD_ASSET
              </Button>
              <Button variant="dashed" size="sm" className="text-foreground">
                <Upload className="w-3.5 h-3.5" />
                UPLOAD_CLIP
              </Button>
            </div>
            <ContextMenuDemo />
          </div>

          {/* Inputs */}
          <div className="space-y-5 bg-black/20 border border-cyan-900/20 rounded-lg p-5">
            <h3 className="text-xs font-mono font-bold text-cyan-400/70 uppercase tracking-[0.15em] border-b border-cyan-500/20 pb-3" style={{ textShadow: '0 0 10px rgba(0,212,255,0.3)' }}>Inputs</h3>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <p className="text-[11px] font-mono text-muted-foreground/70">Default</p>
                <Input placeholder="Enter text..." />
              </div>
              <div className="space-y-1.5">
                <p className="text-[11px] font-mono text-muted-foreground/70">Email</p>
                <Input type="email" placeholder="user@example.com" />
              </div>
              <div className="space-y-1.5">
                <p className="text-[11px] font-mono text-muted-foreground/70">Disabled</p>
                <Input placeholder="Disabled" disabled />
              </div>
            </div>
          </div>

          {/* Selection Controls */}
          <div className="space-y-5 bg-black/20 border border-cyan-900/20 rounded-lg p-5">
            <h3 className="text-xs font-mono font-bold text-cyan-400/70 uppercase tracking-[0.15em] border-b border-cyan-500/20 pb-3" style={{ textShadow: '0 0 10px rgba(0,212,255,0.3)' }}>Selection Controls</h3>
            <div className="space-y-4">
              <div className="w-[200px]">
                <SelectWithChevronDemo />
              </div>
              <GenToggleDemo />
              <GenSelectDemo />
            </div>
          </div>
        </div>

        {/* Neon divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />

        {/* Row 2 — 2-column grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          {/* Gen Text Fields */}
          <div className="space-y-5 bg-black/20 border border-cyan-900/20 rounded-lg p-5">
            <h3 className="text-xs font-mono font-bold text-cyan-400/70 uppercase tracking-[0.15em] border-b border-cyan-500/20 pb-3" style={{ textShadow: '0 0 10px rgba(0,212,255,0.3)' }}>Gen Text Fields</h3>
            <GenFieldDemo />
          </div>

          {/* Multi-Prompt Editor */}
          <div className="space-y-5 bg-black/20 border border-cyan-900/20 rounded-lg p-5">
            <h3 className="text-xs font-mono font-bold text-cyan-400/70 uppercase tracking-[0.15em] border-b border-cyan-500/20 pb-3" style={{ textShadow: '0 0 10px rgba(0,212,255,0.3)' }}>Multi-Prompt Editor</h3>
            <MultiPromptEditorDemo />
          </div>
        </div>

        {/* Neon divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />

        {/* Row 3 — Chat Input full-width */}
        <div className="space-y-5 bg-black/20 border border-cyan-900/20 rounded-lg p-5">
          <h3 className="text-xs font-mono font-bold text-cyan-400/70 uppercase tracking-[0.15em] border-b border-cyan-500/20 pb-3" style={{ textShadow: '0 0 10px rgba(0,212,255,0.3)' }}>Chat Input</h3>
          <p className="text-[11px] font-mono text-muted-foreground/60">Type @ to trigger autocomplete with sample asset slugs</p>
          <ChatInput assetSlugs={['@hero-intro', '@product-shot', '@bg-neon', '@outro-final', '@clip-dance']} />
        </div>

        {/* Neon divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />

        {/* Row 4 — ExecuteButton + CloseButton */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div className="space-y-5 bg-black/20 border border-cyan-900/20 rounded-lg p-5">
            <h3 className="text-xs font-mono font-bold text-cyan-400/70 uppercase tracking-[0.15em] border-b border-cyan-500/20 pb-3" style={{ textShadow: '0 0 10px rgba(0,212,255,0.3)' }}>ExecuteButton</h3>
            <ExecuteButtonStatesDemo />
          </div>
          <div className="space-y-5 bg-black/20 border border-cyan-900/20 rounded-lg p-5">
            <h3 className="text-xs font-mono font-bold text-cyan-400/70 uppercase tracking-[0.15em] border-b border-cyan-500/20 pb-3" style={{ textShadow: '0 0 10px rgba(0,212,255,0.3)' }}>CloseButton</h3>
            <div className="flex items-center gap-6">
              <div className="space-y-2 text-center">
                <CloseButton onClick={() => {}} />
                <p className="text-[11px] font-mono text-muted-foreground/70">enabled</p>
              </div>
              <div className="space-y-2 text-center">
                <CloseButton onClick={() => {}} disabled />
                <p className="text-[11px] font-mono text-muted-foreground/70">disabled</p>
              </div>
            </div>
          </div>
        </div>

        {/* Neon divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />

        {/* Row 5 — Asset Drop Slots */}
        <div className="space-y-5 bg-black/20 border border-cyan-900/20 rounded-lg p-5">
          <h3 className="text-xs font-mono font-bold text-cyan-400/70 uppercase tracking-[0.15em] border-b border-cyan-500/20 pb-3" style={{ textShadow: '0 0 10px rgba(0,212,255,0.3)' }}>Asset Drop Slots</h3>
          <AssetDropSlotDemo />
        </div>
      </section>

      {/* Badges */}
      <section className="space-y-8">
        <div className="flex items-center gap-4">
          <div className="w-1.5 h-8 bg-primary rounded-full shadow-[0_0_12px_var(--color-primary)]" />
          <h2 className="text-2xl font-mono font-bold text-foreground tracking-wide uppercase">Badges</h2>
        </div>
        <div className="flex flex-wrap gap-5">
          <div className="relative w-[200px] h-[120px] bg-card border-2 border-border/40 rounded-lg overflow-hidden shadow-lg">
            <SlugBadge slug="@hero-intro" colorScheme="cyan" isError={false} />
          </div>
          <div className="relative w-[200px] h-[120px] bg-card border-2 border-border/40 rounded-lg overflow-hidden shadow-lg">
            <SlugBadge slug="@final-export" colorScheme="gold" isError={false} />
          </div>
          <div className="relative w-[200px] h-[120px] bg-card border-2 border-border/40 rounded-lg overflow-hidden shadow-lg">
            <SlugBadge slug="@broken-clip" colorScheme="cyan" isError={true} />
          </div>
          <div className="relative w-[200px] h-[120px] bg-card border-2 border-border/40 rounded-lg overflow-hidden shadow-lg">
            <SlugBadge slug="@processing" colorScheme="cyan" isError={false} isProcessing />
          </div>
          <div className="relative w-[200px] h-[120px] bg-card border-2 border-border/40 rounded-lg overflow-hidden shadow-lg">
            <DurationBadge duration="1:30" isProcessing={false} />
          </div>
          <div className="relative w-[200px] h-[120px] bg-card border-2 border-border/40 rounded-lg overflow-hidden shadow-lg">
            <DurationBadge duration="0:45" isProcessing={true} />
          </div>
          <div className="relative w-[200px] h-[120px] bg-card border-2 border-border/40 rounded-lg overflow-hidden shadow-lg">
            <ResolutionBadge width={1920} height={1080} />
          </div>
          <div className="relative w-[200px] h-[120px] bg-card border-2 border-border/40 rounded-lg overflow-hidden shadow-lg">
            <ResolutionBadge width={3840} height={2160} />
          </div>
        </div>
      </section>

      {/* JsonSyntax */}
      <section className="space-y-8">
        <div className="flex items-center gap-4">
          <div className="w-1.5 h-8 bg-primary rounded-full shadow-[0_0_12px_var(--color-primary)]" />
          <h2 className="text-2xl font-mono font-bold text-foreground tracking-wide uppercase">JsonSyntax</h2>
        </div>
        <div className="max-w-xl bg-card border-2 border-border/40 rounded-xl p-6 shadow-[0_0_30px_rgba(0,0,0,0.3)]">
          <JsonSyntax data={{
            project: 'clipfirst',
            version: 2.1,
            active: true,
            models: ['veo3', 'kling3', 'wan21'],
            config: {
              resolution: '1920x1080',
              fps: 30,
              hdr: null,
            },
          }} />
        </div>
      </section>

      {/* Timeline Slots */}
      <section className="space-y-8 p-10 -mx-8 bg-gradient-to-b from-card/30 to-transparent border-y border-border/20">
        <div className="flex items-center gap-4">
          <div className="w-1.5 h-8 bg-primary rounded-full shadow-[0_0_12px_var(--color-primary)]" />
          <h2 className="text-2xl font-mono font-bold text-foreground tracking-wide uppercase">Timeline Slots</h2>
        </div>

        <div className="grid grid-cols-2 gap-6">
          {/* Empty */}
          <div>
            <p className="text-[11px] font-mono text-muted-foreground/70 mb-3 tracking-wide">Empty</p>
            <div className="h-28 flex gap-0.5">
              <TimelineSlotDemo label="@s01" />
            </div>
          </div>

          {/* Filled */}
          <div>
            <p className="text-[11px] font-mono text-muted-foreground/70 mb-3 tracking-wide">Filled</p>
            <div className="h-28 flex gap-0.5">
              <TimelineSlotDemo label="@s01" hasContent thumbnailSrc="/styleguide-vid-purple-grind.jpg" assetId="vid-purple-grind" />
            </div>
          </div>

          {/* Active */}
          <div>
            <p className="text-[11px] font-mono text-muted-foreground/70 mb-3 tracking-wide">Active (selected)</p>
            <div className="h-28 flex gap-0.5">
              <TimelineSlotDemo label="@s02" hasContent thumbnailSrc="/styleguide-img-neon-fox.jpg" assetId="vid-neon-fox" isActive />
            </div>
          </div>

          {/* Drag Over */}
          <div>
            <p className="text-[11px] font-mono text-muted-foreground/70 mb-3 tracking-wide">Drag Over</p>
            <div className="h-28 flex gap-0.5">
              <TimelineSlotDemo label="@s03" isDragOver />
            </div>
          </div>
        </div>

        {/* Multi-slot timeline with playhead */}
        <div className="pt-2">
          <p className="text-[11px] font-mono text-muted-foreground/70 mb-3 tracking-wide">Multi-slot timeline with playhead</p>
          <div className="relative h-28 flex gap-0.5 border border-border/30 rounded-md overflow-hidden">
            <TimelineSlotDemo label="@s01" hasContent thumbnailSrc="/styleguide-vid-purple-grind.jpg" assetId="vid-purple-grind" flex={3} />
            <TimelineSlotDemo label="@s02" hasContent thumbnailSrc="/styleguide-img-neon-fox.jpg" assetId="vid-neon-fox" isActive flex={2} />
            <TimelineSlotDemo label="@s03" hasContent thumbnailSrc="/styleguide-vid-sky-ghost.jpg" assetId="vid-sky-ghost" flex={3} />
            <TimelineSlotDemo label="@s04" flex={2} />
            <TimelineSlotDemo label="@s05" flex={2} />
            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-primary z-[100] pointer-events-none shadow-[0_0_8px_var(--color-primary)]"
              style={{ left: '55%' }}
            />
          </div>
        </div>
      </section>

      {/* CenterStage: IdleScreen */}
      <IdleScreenSection />

      {/* CenterStage: AssetViewShell */}
      <AssetViewShellSection />

      {/* CenterStage: TransmissionView */}
      <CenterStageSection />

      {/* CenterStage: RenderingReadout */}
      <RenderingReadoutSection />

      {/* CenterStage: FailedAssetReadout */}
      <FailedAssetReadoutSection />

      {/* VideoTrimView */}
      <VideoTrimViewSection />

      {/* Player Controls */}
      <PlayerControlsSection />

      {/* Player Interface */}
      <PlayerInterfaceSection />

      {/* Audio Player */}
      <AudioPlayerSection />

      {/* Audio Track */}
      <AudioTrackSection />

      {/* Timeline Scrubber */}
      <TimelineScrubberSection />

      {/* Video Settings Modal */}
      <VideoSettingsModalSection />

      {/* CollapsibleSidebar */}
      <CollapsibleSidebarSection />

      {/* Gen System */}
      <GenSystemSection />

      {/* Pending Generations */}
      <PendingGenerationsSection />

      {/* Chat & Messaging */}
      <ChatMessagingSection />

    </div>
  );
}
