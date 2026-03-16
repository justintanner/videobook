import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useRoute } from 'wouter';
import { useWavesurfer } from '@wavesurfer/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { VideoCard } from '@/components/sidebar/cards/VideoCard';
import { FinalVideoCard } from '@/components/sidebar/cards/FinalVideoCard';
import { ImageCard } from '@/components/sidebar/cards/ImageCard';
import { AudioCard } from '@/components/sidebar/cards/AudioCard';
import { ScriptCard } from '@/components/sidebar/cards/ScriptCard';
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
import { AutocompleteDropdown } from '@/components/ui/AutocompleteDropdown';
import type { CommandDescriptor } from '@/lib/command-registry';
import { CommandButton, InboxButton, type ExecuteButtonState, type GenerationState } from '@/components/commands';
import { AssetViewShell, IdleScreen, TransmissionView, RenderingReadout, AssetViewer } from '@/components/center-stage';
import { ScriptReadout } from '@/components/chat/ScriptReadout';
import { SidebarHeader } from '@/components/sidebar/SidebarHeader';
import { CollapsibleSidebar } from '@/components/sidebar/CollapsibleSidebar';
import { CloseButton, GenPanel, ModelSelector } from '@/components/gen/ui';
import type { ModelOption } from '@/components/gen/types';
import type { MediaItem } from '@/components/sidebar/types';
import { TimelineSlot } from '@/components/timeline/TimelineSlot';
import { UploadSlot } from '@/components/sidebar/UploadSlot';
import {
  FolderOpen, X, ChevronDown, Download, Sparkles,
  Film, Grid3x3, Scissors, Music, Clapperboard,
  Zap, ImageIcon, Info, Settings, User, Copy, Trash2,
  AlertTriangle, AudioLines, Plus, Pencil,
  Smartphone, Monitor, Square, Play, Loader2, Mic,
  Check, History, RotateCcw,
} from 'lucide-react';
import { ProjectButton } from '@/components/layout/ProjectButton';

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
{ item: { id: 'o-untranscribed', type: 'video', slug: '@interview', title: 'Untranscribed', filePath: '/styleguide-vid-purple-grind.jpg', status: 'untranscribed', durationSeconds: 120, origin: 'veo3', thumbnailSrc: '/styleguide-vid-purple-grind.jpg' }, Component: VideoCard },
  { item: { id: 'o-transcribing', type: 'video', slug: '@interview-final', title: 'Transcribing', filePath: '/styleguide-vid-turret-cyber.jpg', status: 'transcribing', durationSeconds: 120, origin: 'veo3', thumbnailSrc: '/styleguide-vid-turret-cyber.jpg' }, Component: VideoCard },
  { item: { id: 'o-corrupt', type: 'video', slug: '@glitched', title: 'Corrupt', filePath: '', status: 'corrupt', durationSeconds: 45, origin: 'veo3', thumbnailSrc: null }, Component: VideoCard },
  { item: { id: 'o-error', type: 'video', slug: '@broken-clip', title: 'Error', filePath: '', status: 'error', durationSeconds: 30, origin: 'veo3', thumbnailSrc: null }, Component: VideoCard },
  { item: { id: 'o-elf', type: 'final', slug: '@final', title: 'Elf Building', filePath: '', status: 'rendering', durationSeconds: 180, thumbnailSrc: '/styleguide-final-thumb.jpg' }, Component: FinalVideoCard },
  { item: { id: 'o-final-ready', type: 'final', slug: '@final-export-v2', title: 'Final Ready', filePath: '/final.mp4', status: 'ready', durationSeconds: 180, thumbnailSrc: '/styleguide-final-thumb.jpg' }, Component: FinalVideoCard },
];

const reviewQueueItems: MediaItem[] = [
  { id: 'rq-1', type: 'video', slug: '@hero-intro', title: 'Hero Intro', filePath: '/styleguide-vid-purple-grind.jpg', status: 'ready', durationSeconds: 12, width: 1920, height: 1080, origin: 'veo3', thumbnailSrc: '/styleguide-vid-purple-grind.jpg' },
  { id: 'rq-2', type: 'video', slug: '@product-shot', title: 'Product Shot', filePath: '/styleguide-vid-turret-cyber.jpg', status: 'ready', durationSeconds: 8, width: 1080, height: 1080, origin: 'kling3', thumbnailSrc: '/styleguide-vid-turret-cyber.jpg' },
  { id: 'rq-3', type: 'video', slug: '@sky-transition', title: 'Sky Transition', filePath: '/styleguide-vid-sky-ghost.jpg', status: 'ready', durationSeconds: 5, width: 1920, height: 1080, origin: 'wan21', thumbnailSrc: '/styleguide-vid-sky-ghost.jpg' },
  { id: 'rq-4', type: 'video', slug: '@neon-overlay', title: 'Neon Overlay', filePath: '/styleguide-img-neon-fox.jpg', status: 'ready', durationSeconds: 15, width: 1080, height: 1920, origin: 'nano_banana', thumbnailSrc: '/styleguide-img-neon-fox.jpg' },
  { id: 'rq-5', type: 'video', slug: '@cyber-montage', title: 'Cyber Montage', filePath: '/styleguide-img-cyber-fresh.jpg', status: 'ready', durationSeconds: 10, width: 1920, height: 1080, origin: 'veo3', thumbnailSrc: '/styleguide-img-cyber-fresh.jpg' },
  { id: 'rq-6', type: 'video', slug: '@brand-reveal', title: 'Brand Reveal', filePath: '/styleguide-img-cover.jpg', status: 'ready', durationSeconds: 6, width: 1080, height: 1080, origin: 'kling3', thumbnailSrc: '/styleguide-img-cover.jpg' },
  { id: 'rq-7', type: 'video', slug: '@final-hook', title: 'Final Hook', filePath: '/styleguide-final-thumb.jpg', status: 'ready', durationSeconds: 18, width: 1080, height: 1920, origin: 'wan21', thumbnailSrc: '/styleguide-final-thumb.jpg' },
  { id: 'rq-8', type: 'video', slug: '@outro-fade', title: 'Outro Fade', filePath: '/styleguide-vid-purple-grind.jpg', status: 'ready', durationSeconds: 9, width: 1920, height: 1080, origin: 'veo3', thumbnailSrc: '/styleguide-vid-purple-grind.jpg' },
];

const pendingQueueItems = [
  { id: 'pq-1', slug: '@intro-v2', tag: 'GEN' },
  { id: 'pq-2', slug: '@b-roll-city', tag: 'DL' },
  { id: 'pq-3', slug: '@cta-end', tag: 'GEN' },
  { id: 'pq-4', slug: '@ambient-loop', tag: 'GEN' },
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
        <CommandButton command="/vax" icon={<FolderOpen className="w-3.5 h-3.5" />} chevron="down" />

        {/* Generations */}
        <InboxButton state="ready" generatingCount={0} readyCount={4} flashKey={0} onClick={() => {}} />
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1">
        <CommandButton command="/final" icon={<Clapperboard className="w-3.5 h-3.5" />} />
      </div>
    </div>
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

function ClipContextMenu({ children }: { children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="text-[10px] font-mono text-muted-foreground/60">clip</ContextMenuLabel>
        <ContextMenuItem className="text-xs font-mono gap-2"><Play className="w-3.5 h-3.5" /> <span><span className="text-primary/25 text-[0.65em]">/</span>preview</span></ContextMenuItem>
        <ContextMenuItem className="text-xs font-mono gap-2"><Scissors className="w-3.5 h-3.5" /> <span><span className="text-primary/25 text-[0.65em]">/</span>trim</span></ContextMenuItem>
        <ContextMenuItem className="text-xs font-mono gap-2"><Download className="w-3.5 h-3.5" /> <span><span className="text-primary/25 text-[0.65em]">/</span>download</span></ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-xs font-mono gap-2"><Copy className="w-3.5 h-3.5" /> <span><span className="text-primary/25 text-[0.65em]">/</span>duplicate</span></ContextMenuItem>
        <ContextMenuItem className="text-xs font-mono gap-2"><Mic className="w-3.5 h-3.5" /> <span><span className="text-primary/25 text-[0.65em]">/</span>transcribe</span></ContextMenuItem>
        <ContextMenuItem className="text-xs font-mono gap-2"><Film className="w-3.5 h-3.5" /> <span><span className="text-primary/25 text-[0.65em]">/</span>render</span></ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-xs font-mono gap-2 text-destructive"><Trash2 className="w-3.5 h-3.5" /> <span><span className="text-primary/25 text-[0.65em]">/</span>delete</span></ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const allExecuteStates: ExecuteButtonState[] = ['disabled', 'ready', 'processing', 'success'];

function ExecuteButtonStatesDemo() {
  return (
    <div className="space-y-2.5">
      {allExecuteStates.map((state) => (
        <div key={state} className="flex items-center gap-4">
          <span className="text-[11px] font-mono text-muted-foreground/70 w-24 shrink-0">{state}</span>
          <div className="flex-1 max-w-[240px]">
            <CommandButton command="/generate" icon={<Zap className="w-5 h-5" />} size="lg" state={state} disabledReason="Fill required fields" />
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


// ── CenterStage: AssetViewShell ──

const assetViewShellMocks = [
  { id: 'shell-constrained', label: 'constrained (fillParent=false)', fillParent: false },
  { id: 'shell-full', label: 'full bleed (fillParent=true)', fillParent: true },
];


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


// ── VideoTrimView (static replica) ──

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

// ── Pending Generations Section ──

const pendingGenButtonStates: { label: string; state: GenerationState; generatingCount: number; readyCount: number }[] = [
  { label: 'inactive', state: 'inactive', generatingCount: 0, readyCount: 0 },
  { label: 'generating', state: 'generating', generatingCount: 3, readyCount: 0 },
  { label: 'ready', state: 'ready', generatingCount: 0, readyCount: 4 },
  { label: 'ready + generating', state: 'ready', generatingCount: 2, readyCount: 3 },
];

// ── Chat & Messaging Section ──

const sampleScript = `INT. NEON ALLEY - NIGHT

A figure in a long coat walks through rain-slicked streets. Holographic advertisements flicker overhead, casting cyan light across wet pavement.

NARRATOR (V.O.)
In the year 2087, the line between human and machine had blurred beyond recognition.

The figure stops, looking up at a massive screen displaying a countdown timer.

NARRATOR (V.O.)
But some things never change. The need to create. To tell stories. To be heard.`;


// ── Git History Mock Data ──

type CommitOperation = 'create' | 'generate' | 'upload' | 'render' | 'restore' | 'delete' | 'rename';

interface MockCommit {
  hash: string;
  message: string;
  timestamp: string;
}

const OPERATION_STYLES: Record<CommitOperation, { dot: string; label: string }> = {
  create:   { dot: 'bg-emerald-500', label: 'text-emerald-400' },
  generate: { dot: 'bg-primary',     label: 'text-primary' },
  upload:   { dot: 'bg-blue-500',    label: 'text-blue-400' },
  render:   { dot: 'bg-amber-500',   label: 'text-amber-400' },
  restore:  { dot: 'bg-violet-500',  label: 'text-violet-400' },
  delete:   { dot: 'bg-red-500',     label: 'text-red-400' },
  rename:   { dot: 'bg-zinc-500',    label: 'text-zinc-400' },
};

function extractOperation(message: string): CommitOperation {
  const first = message.split(/[\s:(]/)[0].toLowerCase();
  if (first in OPERATION_STYLES) return first as CommitOperation;
  return 'create';
}

const mockCommits: MockCommit[] = [
  { hash: 'a3f8c1d', message: 'generate: re-generate hero intro with updated prompt',       timestamp: '18 min ago' },
  { hash: 'b1e2d3c', message: 'restore: reverted to version c2d3e4f',                       timestamp: 'yesterday' },
  { hash: 'c2d3e4f', message: 'render: composite with background music track',               timestamp: 'yesterday' },
  { hash: 'd3e4f5a', message: 'generate: initial hero intro generation',                     timestamp: '2 days ago' },
  { hash: 'e4f5a6b', message: 'generate: test generation with alternate prompt',             timestamp: '2 days ago' },
  { hash: 'f5a6b7c', message: 'upload: uploaded raw footage from camera',                    timestamp: '3 days ago' },
  { hash: 'a6b7c8d', message: 'rename: renamed from untitled-clip-003',                      timestamp: '4 days ago' },
  { hash: 'b7c8d9e', message: 'create: asset created',                                       timestamp: '4 days ago' },
];

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground/50 uppercase">{label}</span>
      <span className="text-sm font-mono text-foreground/80">{children}</span>
    </div>
  );
}

function TimelineNode({ commit, isHead }: { commit: MockCommit; isHead: boolean }) {
  const op = extractOperation(commit.message);
  const style = OPERATION_STYLES[op];
  return (
    <div className="relative flex items-start gap-4 pl-[15px] py-2 group">
      {/* Vertical line */}
      <div className="absolute left-[15px] top-0 bottom-0 w-px bg-border/40" />
      {/* Dot */}
      <div className="relative z-10 shrink-0 flex items-center justify-center" style={{ width: 12, height: 24 }}>
        {isHead ? (
          <div className="relative">
            <div className={cn('w-3 h-3 rounded-full', style.dot)} />
            <div className={cn('absolute inset-0 w-3 h-3 rounded-full animate-ping opacity-40', style.dot)} />
          </div>
        ) : (
          <div className={cn('w-2 h-2 rounded-full', style.dot)} />
        )}
      </div>
      {/* Content */}
      <div className="flex-1 flex items-baseline justify-between gap-3 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={cn('text-xs font-mono font-bold', style.label)}>{op}</span>
          <span className="text-[11px] font-mono text-muted-foreground/60">{commit.hash}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[11px] font-mono text-muted-foreground/50">{commit.timestamp}</span>
          {!isHead && (
            <button className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider text-violet-400 bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 transition-colors uppercase">
              <RotateCcw className="w-3 h-3" />
              Restore
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Slide Deck Infrastructure ──

function useSlideScale() {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const update = () => {
      const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
      setScale(s);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return scale;
}

function useSlideNavigation(totalSlides: number) {
  const [, params] = useRoute('/styleguide/:page');
  const [, navigate] = useLocation();

  const initialSlide = params?.page ? Math.max(0, Math.min(Number(params.page) - 1, totalSlides - 1)) : 0;
  const [currentSlide, setCurrentSlide] = useState(initialSlide);

  const updateUrl = useCallback((slide: number) => {
    navigate(`/styleguide/${slide + 1}`, { replace: true });
  }, [navigate]);

  // Set URL on initial mount if no page param
  useEffect(() => {
    if (!params?.page) updateUrl(initialSlide);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = useCallback((i: number) => {
    const clamped = Math.max(0, Math.min(i, totalSlides - 1));
    setCurrentSlide(clamped);
    updateUrl(clamped);
  }, [totalSlides, updateUrl]);

  const next = useCallback(() => setCurrentSlide((c) => {
    const n = Math.min(c + 1, totalSlides - 1);
    updateUrl(n);
    return n;
  }), [totalSlides, updateUrl]);

  const prev = useCallback(() => setCurrentSlide((c) => {
    const n = Math.max(c - 1, 0);
    updateUrl(n);
    return n;
  }), [updateUrl]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); next(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); prev(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [next, prev]);

  useEffect(() => {
    let startY = 0;
    const onStart = (e: TouchEvent) => { startY = e.touches[0].clientY; };
    const onEnd = (e: TouchEvent) => {
      const delta = startY - e.changedTouches[0].clientY;
      if (Math.abs(delta) > 50) { if (delta > 0) next(); else prev(); }
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => { window.removeEventListener('touchstart', onStart); window.removeEventListener('touchend', onEnd); };
  }, [next, prev]);

  return { currentSlide, goTo, next, prev };
}

function Slide({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative w-[1920px] h-[1080px] bg-background overflow-hidden">
      <div className="absolute inset-0 py-6 px-6 flex flex-col overflow-hidden">{children}</div>
    </div>
  );
}

// ── Slide 1: Final Video Preview ──

function Page1_FinalVideoPreview() {
  return (
    <div className="w-full h-full overflow-hidden rounded-lg border border-border/60 bg-background shadow-[0_0_40px_-12px_rgba(0,212,255,0.08)]">
      <div className="grid grid-rows-[48px_1fr_auto] h-full">
        <HeaderBar />
        <div className="flex flex-row overflow-hidden">
          {/* Left Sidebar — Assets */}
          <CollapsibleSidebar side="left" collapsed={false} onToggle={() => {}} expandedWidth="240px" collapsedWidth="40px" padding="px-2 pt-2 pb-2" gap="gap-0">
            <SidebarHeader icon={<Grid3x3 className="w-3.5 h-3.5" />} title="Assets" collapsed={false} onToggle={() => {}} side="left" sortOrder="newest" onSortChange={() => {}} />
            <div className="flex-1 overflow-y-auto space-y-2 pr-2">
              <div className="w-full"><ImageCard item={demoImageMock} /></div>
              <div className="w-full"><ImageCard item={{ ...demoImageMock, id: 'demo-img-2', slug: '@img-cover', thumbnailSrc: '/styleguide-img-cover.jpg', filePath: '/styleguide-img-cover.jpg' }} /></div>
              <div className="w-full"><ScriptCard item={{ id: 'demo-script', type: 'script', slug: '@script', title: 'Script', filePath: '/script.md', status: 'ready', prompt: sampleScript }} /></div>
              <div className="w-full"><AudioCard item={{ id: 'demo-audio', type: 'audio', slug: '@bg-music', title: 'Background Music', filePath: '/audio.mp3', status: 'ready' }} /></div>
              <UploadSlot />
            </div>
          </CollapsibleSidebar>

          {/* Center Stage — Video Player */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 p-4 overflow-hidden flex flex-col">
              <AssetViewShell fillParent>
                <video
                  src="/fixtures/video-frost.mp4"
                  className="w-full h-full object-contain"
                  controls
                  loop
                  muted
                  playsInline
                  poster="/styleguide-img-cover.jpg"
                />
              </AssetViewShell>
            </div>
            <div className="shrink-0 px-4 pb-3 pt-2">
              <ChatInput assetSlugs={['@hero-intro', '@product-shot', '@bg-neon', '@outro-final', '@clip-dance']} />
            </div>
          </div>

          {/* Right Sidebar — Clips */}
          <CollapsibleSidebar side="right" collapsed={false} onToggle={() => {}} expandedWidth="240px" collapsedWidth="40px" padding="px-2 pt-2 pb-2" gap="gap-0">
            <SidebarHeader icon={<Grid3x3 className="w-3.5 h-3.5" />} title="Clips" collapsed={false} onToggle={() => {}} side="right" sortOrder="newest" onSortChange={() => {}} />
            <div className="flex-1 overflow-y-auto space-y-2 mt-2 pr-2">
              <ClipContextMenu>
                <div className="w-full"><VideoCard item={{ id: 'clip-s01', type: 'video', slug: '@s01', title: 'Purple Grind', filePath: '/styleguide-vid-purple-grind.jpg', status: 'ready', durationSeconds: 90, origin: 'wan21', thumbnailSrc: '/styleguide-vid-purple-grind.jpg' }} /></div>
              </ClipContextMenu>
              <ClipContextMenu>
                <div className="w-full"><VideoCard item={{ id: 'clip-s02', type: 'video', slug: '@s02', title: 'Neon Fox', filePath: '/styleguide-img-neon-fox.jpg', status: 'ready', durationSeconds: 60, origin: 'veo3', thumbnailSrc: '/styleguide-img-neon-fox.jpg' }} /></div>
              </ClipContextMenu>
              <ClipContextMenu>
                <div className="w-full"><VideoCard item={{ id: 'clip-s03', type: 'video', slug: '@s03', title: 'Sky Ghost', filePath: '/styleguide-vid-sky-ghost.jpg', status: 'ready', durationSeconds: 75, origin: 'veo3', thumbnailSrc: '/styleguide-vid-sky-ghost.jpg' }} /></div>
              </ClipContextMenu>
              <ClipContextMenu>
                <div className="w-full"><FinalVideoCard item={{ id: 'demo-final-ready', type: 'final', slug: '@final-export-v2', title: 'Final Ready', filePath: '/final.mp4', status: 'ready', durationSeconds: 180, thumbnailSrc: '/styleguide-final-thumb.jpg' }} /></div>
              </ClipContextMenu>
              <UploadSlot />
            </div>
          </CollapsibleSidebar>
        </div>

        {/* Timeline */}
        <div className="border-t border-border bg-card/30">
          <div className="relative h-28 flex gap-0.5">
            <TimelineSlot label="@s01" hasContent thumbnailSrc="/styleguide-vid-purple-grind.jpg" assetId="vid-purple-grind" flex={3} />
            <TimelineSlot label="@s02" hasContent thumbnailSrc="/styleguide-img-neon-fox.jpg" assetId="vid-neon-fox" isActive flex={2} />
            <TimelineSlot label="@s03" hasContent thumbnailSrc="/styleguide-vid-sky-ghost.jpg" assetId="vid-sky-ghost" flex={3} />
            <TimelineSlot label="@s04" flex={2} />
            <TimelineSlot label="@s05" flex={2} />
            <div className="absolute top-0 bottom-0 w-0.5 bg-primary z-[100] pointer-events-none shadow-[0_0_8px_var(--color-primary)]" style={{ left: '42%' }} />
          </div>
          <div className="relative h-12 border-t border-border/30 bg-card/20">
            <div className="absolute top-0 bottom-0 rounded border border-cyan-400/40 bg-cyan-950/30 overflow-hidden" style={{ left: '8%', width: '55%' }}>
              <div className="absolute inset-0 px-1 flex items-center"><StyleguideWaveform url="/fixtures/audio-red.mp3" height={30} progress={0.42} /></div>
              <div className="absolute bottom-0.5 left-1 z-20"><span className="text-[10px] font-mono text-cyan-400/80 px-1 py-0.5 rounded bg-black/70">@bg-music</span></div>
            </div>
            <div className="absolute top-0 bottom-0 w-0.5 bg-primary z-[100] pointer-events-none shadow-[0_0_8px_var(--color-primary)]" style={{ left: '42%' }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Slide 2: Video Generation (reuses AppLayoutDemo internals) ──

function Page2_VideoGeneration() {
  return (
    <div className="w-full h-full overflow-hidden rounded-lg border border-border/60 bg-background shadow-[0_0_40px_-12px_rgba(0,212,255,0.08)]">
      <div className="grid grid-rows-[48px_1fr_auto] h-full">
        <HeaderBar />
        <div className="flex flex-row overflow-hidden">
          <CollapsibleSidebar side="left" collapsed={false} onToggle={() => {}} expandedWidth="240px" collapsedWidth="40px" padding="px-2 pt-2 pb-2" gap="gap-0">
            <SidebarHeader icon={<Grid3x3 className="w-3.5 h-3.5" />} title="Assets" collapsed={false} onToggle={() => {}} side="left" sortOrder="newest" onSortChange={() => {}} />
            <div className="flex-1 overflow-y-auto space-y-2 pr-2">
              <div className="w-full"><ImageCard item={demoImageMock} /></div>
              <UploadSlot />
            </div>
          </CollapsibleSidebar>

          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 p-4 overflow-y-auto flex flex-col">
              {/* VIDEO_GENERATION Panel */}
              <div className="relative w-full flex-1 overflow-hidden bg-gradient-to-b from-cyan-950/30 via-black to-black rounded flex flex-col">
                <div className="absolute inset-0 pointer-events-none scanlines opacity-20 z-10" />
                <div className="absolute inset-0 pointer-events-none opacity-5" style={{ backgroundImage: 'linear-gradient(rgba(0, 255, 255, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 255, 0.1) 1px, transparent 1px)', backgroundSize: '4px 4px' }} />
                <div className="relative z-20 flex-1 flex flex-col border-2 border-cyan-400/50 shadow-[0_0_30px_-10px_rgba(0,255,255,0.3)]">
                  <div className="flex items-center justify-between pl-2.5 pr-2.5 py-1.5 shrink-0 border-b-2 border-inherit bg-black/50 backdrop-blur-sm">
                    <div className="flex items-center gap-2">
                      <Film className="w-4 h-4 text-cyan-400 drop-shadow-[0_0_6px_#22d3ee]" />
                      <span className="text-xs font-bold tracking-[0.15em] text-cyan-400">VIDEO_GENERATION</span>
                    </div>
                    <button className="w-7 h-7 flex items-center justify-center text-primary/60 transition-all hover:bg-red-500/10 hover:text-red-400">
                      <X className="w-5 h-5 stroke-[2.5]" />
                    </button>
                  </div>
                  <div className="flex flex-row flex-1">
                    <div className="flex-1 pl-4 pr-8 py-4 mr-2">
                      <div className="space-y-2 mb-3">
                        <div className="flex items-center justify-between">
                          <BracketLabel label="PROMPT" required />
                          <CommandButton size="sm" command="/rewrite-prompt" icon={<Sparkles className="w-3 h-3" />} />
                        </div>
                        <textarea className="w-full px-3 py-2 resize-none bg-black/60 border border-primary/30 rounded text-primary/90 font-mono text-xs leading-relaxed focus:outline-none focus:border-primary/60 shadow-[inset_0_0_15px_rgba(0,255,255,0.1)] h-28" defaultValue="Create a dynamic and engaging video showcasing a variety of scenes and scenarios, highlighting vibrant visuals and motion." readOnly />
                      </div>
                      <div className="flex flex-wrap gap-x-6 gap-y-4 my-3">
                        <div><BracketLabel label="ASPECT RATIO" /><div className="mt-1.5"><ToggleGroup options={['16:9', '9:16', '1:1']} activeIndex={0} /></div></div>
                        <div><BracketLabel label="DURATION" /><div className="mt-1.5"><FakeDropdown text="8" /></div></div>
                        <div><BracketLabel label="MODE" /><div className="mt-1.5"><ToggleGroup options={['std', 'pro']} activeIndex={0} /></div></div>
                        <div><BracketLabel label="SOUND" /><div className="mt-1.5"><ToggleGroup options={['No', 'Yes']} activeIndex={1} /></div></div>
                      </div>
                    </div>
                    <div className="w-44 border-l border-primary/20 bg-black/20 p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <BracketLabel label="IMAGES" />
                        <span className="text-[10px] font-mono text-primary/50">1/2</span>
                      </div>
                      <div className="relative aspect-video border-2 border-primary/50 bg-black/60 overflow-hidden">
                        <img src="/styleguide-img-cover.jpg" alt="" className="w-full h-full object-cover" />
                      </div>
                      <div className="relative aspect-video border-2 border-primary/30 border-dashed bg-black/60 overflow-hidden flex items-center justify-center">
                        <ImageIcon className="w-5 h-5 text-primary/25 relative z-10" />
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 p-2.5 border-t-2 border-inherit bg-black/30 flex items-center justify-between">
                    <FakeDropdown text="Kling 3.0" />
                    <CommandButton command="/generate" icon={<Zap className="w-5 h-5" />} size="lg" />
                  </div>
                </div>
              </div>
            </div>
            <div className="shrink-0 px-4 pb-3 pt-2">
              <ChatInput assetSlugs={['@hero-intro', '@product-shot', '@bg-neon']} />
            </div>
          </div>

          <CollapsibleSidebar side="right" collapsed={false} onToggle={() => {}} expandedWidth="240px" collapsedWidth="40px" padding="px-2 pt-2 pb-2" gap="gap-0">
            <SidebarHeader icon={<Grid3x3 className="w-3.5 h-3.5" />} title="Clips" collapsed={false} onToggle={() => {}} side="right" sortOrder="newest" onSortChange={() => {}} />
            <div className="flex-1 overflow-y-auto space-y-2 mt-2 pr-2">
              <div className="w-full"><VideoCard item={demoVideoMock} /></div>
            </div>
          </CollapsibleSidebar>
        </div>

        <div className="border-t border-border bg-card/30">
          <div className="relative h-28 flex gap-0.5">
            <TimelineSlot label="@s01" hasContent thumbnailSrc="/styleguide-vid-purple-grind.jpg" assetId="vid-purple-grind" flex={3} />
            <TimelineSlot label="@s02" hasContent thumbnailSrc="/styleguide-img-neon-fox.jpg" assetId="vid-neon-fox" isActive flex={2} />
            <TimelineSlot label="@s03" flex={2} />
            <div className="absolute top-0 bottom-0 w-0.5 bg-primary z-[100] pointer-events-none shadow-[0_0_8px_var(--color-primary)]" style={{ left: '35%' }} />
          </div>
          <div className="border-2 border-dashed rounded flex items-center justify-center gap-2 h-14 min-h-14 border-border/40 text-muted-foreground/50">
            <Music className="w-3.5 h-3.5" /><span className="font-mono text-xs">/add_audio</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Slide 3: Media Catalog ──

function Page3_MediaCatalog() {
  return (
    <div className="w-full h-full flex flex-col gap-6">
      <p className="text-xs font-mono text-zinc-400 leading-relaxed max-w-3xl">All 14 card states: receiving, plan, video, image, and final — every lifecycle phase at a glance.</p>
      <div className="flex-1 flex flex-col justify-center">
        <div className="grid grid-cols-7 gap-4">
          {/* Row 1 */}
          <div><ReceivingGhostCard filename="hero-intro-final.mp4" /></div>
          <div><PlanCard item={{ id: 'plan-empty', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready' }} /></div>
          <div><PlanCard item={{ id: 'plan-filled', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready', prompt: 'Scene 1: Wide establishing shot of the city skyline at golden hour.\n\nScene 2: Close-up of hands typing.' }} /></div>
          <div><VideoCard item={cardOverlayMocks[0].item} /></div>
          <div><VideoCard item={cardOverlayMocks[1].item} /></div>
          <div><VideoCard item={cardOverlayMocks[2].item} /></div>
          <div><VideoCard item={cardOverlayMocks[4].item} /></div>
        </div>
        <div className="grid grid-cols-7 gap-4 mt-4">
          {/* Row 2 */}
          <div><VideoCard item={cardOverlayMocks[6].item} /></div>
          <div><VideoCard item={cardOverlayMocks[7].item} /></div>
          <div><VideoCard item={cardOverlayMocks[8].item} /></div>
          <div><VideoCard item={cardOverlayMocks[9].item} /></div>
          <div><ImageCard item={cardOverlayMocks[3].item} /></div>
          <div><ImageCard item={cardOverlayMocks[5].item} /></div>
          <div />
        </div>
        <div className="flex justify-center gap-4 mt-4">
          {/* Row 3 center */}
          <div className="w-[240px]"><FinalVideoCard item={cardOverlayMocks[10].item} /></div>
          <div className="w-[240px]"><FinalVideoCard item={cardOverlayMocks[11].item} /></div>
        </div>
      </div>
    </div>
  );
}

// ── Slide 4: Design System ──

function Page4_DesignSystem() {
  return (
    <div className="w-full h-full flex gap-12">
      {/* Left third: Colors */}
      <div className="flex-1 flex flex-col">
        <h3 className="text-lg font-mono font-bold tracking-wider text-primary/70 mb-4">COLORS</h3>
        <div className="grid grid-cols-4 gap-4 flex-1 content-start">
          {colors.map((c) => (
            <div key={c.name} className="space-y-2">
              <div className={`${c.bg} rounded-lg h-16 border-2 border-border/40 shadow-lg`} />
              <p className="text-sm font-bold leading-tight tracking-wide">{c.name}</p>
              <p className="text-xs font-mono text-muted-foreground/80">{c.hex}</p>
            </div>
          ))}
        </div>
      </div>
      {/* Center third: Typography */}
      <div className="flex-1 flex flex-col">
        <h3 className="text-lg font-mono font-bold tracking-wider text-primary/70 mb-4">TYPOGRAPHY</h3>
        <div className="space-y-4 flex-1">
          <div className="pb-3 border-b border-border/20">
            <p className="text-3xl font-bold">Rajdhani Bold</p>
            <p className="text-xs font-mono text-muted-foreground/50 mt-1">font-bold / 700</p>
          </div>
          <div className="pb-3 border-b border-border/20">
            <p className="text-2xl font-semibold">Rajdhani Semibold</p>
            <p className="text-xs font-mono text-muted-foreground/50 mt-1">font-semibold / 600</p>
          </div>
          <div className="pb-3 border-b border-border/20">
            <p className="text-xl font-normal">Rajdhani Regular</p>
            <p className="text-xs font-mono text-muted-foreground/50 mt-1">font-normal / 400</p>
          </div>
          <div className="pb-3 border-b border-border/20">
            <p className="text-xl font-light text-foreground/70">Rajdhani Light</p>
            <p className="text-xs font-mono text-muted-foreground/50 mt-1">font-light / 300</p>
          </div>
          <div className="pb-3 border-b border-border/20">
            <p className="font-mono text-lg tracking-wide">JetBrains Mono — 0123456789</p>
            <p className="text-xs font-mono text-muted-foreground/50 mt-1">monospace / code</p>
          </div>
          <div>
            <p className="font-mono text-sm text-primary/70 tracking-wide">const x = await fetchData();</p>
            <p className="text-xs font-mono text-muted-foreground/50 mt-1">monospace / inline code</p>
          </div>
        </div>
      </div>
      {/* Right third: Badges + JsonSyntax */}
      <div className="flex-1 flex flex-col">
        <h3 className="text-lg font-mono font-bold tracking-wider text-primary/70 mb-4">BADGES & DATA</h3>
        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="relative h-[90px] bg-card border-2 border-border/40 rounded-lg overflow-hidden"><SlugBadge slug="@hero-intro" colorScheme="cyan" isError={false} /></div>
          <div className="relative h-[90px] bg-card border-2 border-border/40 rounded-lg overflow-hidden"><SlugBadge slug="@final-export" colorScheme="gold" isError={false} /></div>
          <div className="relative h-[90px] bg-card border-2 border-border/40 rounded-lg overflow-hidden"><SlugBadge slug="@broken-clip" colorScheme="cyan" isError={true} /></div>
          <div className="relative h-[90px] bg-card border-2 border-border/40 rounded-lg overflow-hidden"><SlugBadge slug="@processing" colorScheme="cyan" isError={false} isProcessing /></div>
          <div className="relative h-[90px] bg-card border-2 border-border/40 rounded-lg overflow-hidden"><DurationBadge duration="1:30" isProcessing={false} /></div>
          <div className="relative h-[90px] bg-card border-2 border-border/40 rounded-lg overflow-hidden"><ResolutionBadge width={1920} height={1080} /></div>
        </div>
        <div className="bg-card border-2 border-border/40 rounded-xl p-4 shadow-[0_0_30px_rgba(0,0,0,0.3)]">
          <JsonSyntax data={{ project: 'clipfirst', version: 2.1, active: true, models: ['veo3', 'kling3', 'wan21'], config: { resolution: '1920x1080', fps: 30 } }} />
        </div>
      </div>
    </div>
  );
}

// ── Slide 5: Forms & Controls ──

function Page5_FormsControls() {
  return (
    <div className="w-full h-full flex gap-10">
      {/* Left column: Overlays */}
      <div className="w-[500px] shrink-0 flex flex-col gap-4 overflow-hidden">
        <h3 className="text-lg font-mono font-bold tracking-wider text-primary/70">OVERLAYS & MENUS</h3>
        <div className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild><Button variant="outline" size="sm">Dialog</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>System Diagnostic</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">All subsystems nominal.</p>
              <DialogFooter><DialogClose asChild><Button variant="outline" size="sm">Dismiss</Button></DialogClose></DialogFooter>
            </DialogContent>
          </Dialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><Settings className="w-3.5 h-3.5 mr-1.5" />Dropdown</Button></DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Actions</DropdownMenuLabel><DropdownMenuSeparator />
              <DropdownMenuItem><User className="w-3.5 h-3.5" /> Profile</DropdownMenuItem>
              <DropdownMenuItem><Settings className="w-3.5 h-3.5" /> Settings</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild><Button variant="outline" size="sm"><Info className="w-3.5 h-3.5 mr-1.5" />Popover</Button></PopoverTrigger>
            <PopoverContent><h4 className="text-sm font-mono font-bold text-primary">System Info</h4><p className="text-xs text-muted-foreground">Renderer: WebGPU v2.1</p></PopoverContent>
          </Popover>
          <TooltipProvider>
            <Tooltip><TooltipTrigger asChild><Button variant="outline" size="sm">Tooltip</Button></TooltipTrigger><TooltipContent><p>Neural interface ready</p></TooltipContent></Tooltip>
          </TooltipProvider>
          <Button variant="outline" size="sm" onClick={() => toast({ title: 'TRANSMISSION RECEIVED', description: 'Asset uploaded.' })}>Toast</Button>
          <UploadSlot />
        </div>
        <ContextMenuDemo />
        <div className="flex items-center gap-4 mt-2">
          <h4 className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest">CloseButton</h4>
          <CloseButton onClick={() => {}} />
          <CloseButton onClick={() => {}} disabled />
        </div>
        <AssetDropSlotDemo />
      </div>
      {/* Center column: Inputs + Selects */}
      <div className="w-[420px] shrink-0 flex flex-col gap-4 overflow-hidden">
        <h3 className="text-lg font-mono font-bold tracking-wider text-primary/70">INPUTS & SELECTION</h3>
        <div className="space-y-3">
          <div className="space-y-1.5"><p className="text-[11px] font-mono text-muted-foreground/70">Default</p><Input placeholder="Enter text..." /></div>
          <div className="space-y-1.5"><p className="text-[11px] font-mono text-muted-foreground/70">Email</p><Input type="email" placeholder="user@example.com" /></div>
          <div className="space-y-1.5"><p className="text-[11px] font-mono text-muted-foreground/70">Disabled</p><Input placeholder="Disabled" disabled /></div>
        </div>
        <div className="w-[200px]"><SelectWithChevronDemo /></div>
        <GenToggleDemo />
        <GenSelectDemo />
      </div>
      {/* Right column: GenField + MultiPromptEditor */}
      <div className="flex-1 flex flex-col gap-4 overflow-hidden">
        <h3 className="text-lg font-mono font-bold tracking-wider text-primary/70">GEN FIELDS</h3>
        <GenFieldDemo />
        <div className="mt-2">
          <h4 className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest mb-2">Multi-Prompt Editor</h4>
          <MultiPromptEditorDemo />
        </div>
      </div>
    </div>
  );
}

// ── Slide 6: Center Stage ──

function Page6_CenterStage() {
  const [replayCount, setReplayCount] = useState(0);
  const handleComplete = useCallback(() => setReplayCount((n) => n + 1), []);

  return (
    <div className="w-full h-full grid grid-cols-2 grid-rows-2 gap-6">
      {/* Top-left: IdleScreen */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">IdleScreen</p>
        <div className="flex-1 bg-black/60 rounded-xl overflow-hidden flex border border-cyan-500/20 shadow-[0_0_40px_-10px_rgba(0,212,255,0.15)] ring-1 ring-cyan-500/20 min-h-0">
          <IdleScreen label="WAITING_FOR_INPUT..." badge="SRC: NULL" />
        </div>
      </div>
      {/* Top-right: TransmissionView */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">TransmissionView</p>
        <div className="flex-1 flex flex-col gap-3 min-h-0">
          {centerStageMocks.map((mock) => (
            <div key={`${mock.id}-${replayCount}`} className="flex-1 bg-black/60 rounded-xl overflow-hidden flex flex-col border border-cyan-500/20 ring-1 ring-cyan-500/20 min-h-0">
              <TransmissionView message={mock.message} onComplete={handleComplete} />
            </div>
          ))}
        </div>
      </div>
      {/* Bottom-left: AssetViewShell */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">AssetViewShell</p>
        <div className="flex-1 flex gap-4 min-h-0">
          {assetViewShellMocks.map((mock) => (
            <div key={mock.id} className="flex-1 bg-black/60 rounded-xl overflow-hidden flex border border-cyan-500/20 ring-1 ring-cyan-500/20 min-h-0">
              <AssetViewShell fillParent={mock.fillParent}>
                <div className="flex items-center justify-center w-full h-full">
                  <span className="font-mono text-xs text-cyan-500/40 tracking-widest">CONTENT_AREA</span>
                </div>
              </AssetViewShell>
            </div>
          ))}
        </div>
      </div>
      {/* Bottom-right: RenderingReadout */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">RenderingReadout</p>
        <div className="flex-1 grid grid-cols-2 gap-3 min-h-0">
          {renderingReadoutMocks.slice(0, 4).map((mock) => (
            <div key={mock.id} className="bg-black/60 rounded-xl overflow-hidden border border-cyan-500/20 ring-1 ring-cyan-500/20 min-h-0">
              <RenderingReadout asset={mock.asset} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Slide 7: Video Editing ──

function Page7_Trimming() {
  return (
    <div className="w-full h-full flex flex-col">
      <div className="h-full bg-zinc-950 border border-zinc-600/50 rounded-xl overflow-hidden ring-1 ring-cyan-500/10 flex flex-col">
        <div className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-zinc-700/60 bg-gradient-to-r from-zinc-900 via-zinc-900/95 to-zinc-950 relative">
          <span className="font-mono text-xs tracking-widest text-zinc-400 uppercase">Editing</span>
          <div className="absolute inset-x-0 flex justify-center pointer-events-none">
            <span className="font-mono text-xs tracking-widest text-zinc-400">@hero-intro</span>
          </div>
          <CloseButton onClick={() => {}} />
        </div>
        <div className="flex flex-1 overflow-hidden min-h-0">
          <div className="flex-1 flex flex-col px-4 py-3 overflow-hidden min-w-0">
            <div className="flex-1 min-h-0 flex items-center justify-center">
              <div className="relative w-full h-full bg-black rounded-md overflow-hidden">
                <video loop playsInline controls muted poster="/styleguide-img-cover.jpg" src="/fixtures/video-frost.mp4" className="w-full h-full object-contain" />
              </div>
            </div>
            <div className="shrink-0 mt-3 px-4 py-3 bg-zinc-900/60 rounded-lg border border-zinc-800/40">
              <div className="relative overflow-visible" style={{ height: 80 }}>
                <div className="relative bg-black border border-zinc-700/50 rounded-md overflow-hidden" style={{ height: 80 }}>
                  <div className="absolute inset-0 rounded-md overflow-hidden">
                    <StyleguideWaveform url="/fixtures/video-frost.mp4" height={80} waveColor="rgba(0, 255, 255, 0.15)" progressColor="rgba(0, 255, 255, 0.5)" progress={TRIM_PLAYHEAD_POS / 100} />
                  </div>
                  {trimDemoCutRegions.map((region, i) => (
                    <div key={i} className="absolute top-0 bottom-0 pointer-events-none z-10" style={{ left: `${region.startPercent}%`, width: `${region.widthPercent}%`, background: trimStripedBg }} />
                  ))}
                </div>

                {/* Thumbnail badges — mini thumbnails that expand on hover */}
                {trimTimelineBadges.map((badge, i) => {
                  const inCut = trimDemoCutRegions.some(
                    (r) => badge.percent >= r.startPercent && badge.percent <= r.startPercent + r.widthPercent,
                  );
                  const isStuckHover = i === 2;
                  return (
                    <div
                      key={i}
                      className={cn('absolute z-20', !isStuckHover && 'group')}
                      style={{
                        left: `${badge.percent}%`,
                        top: '50%',
                        transform: 'translate(-50%, -50%)',
                      }}
                    >
                      {/* Timestamp label — visible on hover */}
                      <div className={cn(
                        'absolute bottom-full left-1/2 -translate-x-1/2 mb-1 pointer-events-none z-40 transition-opacity',
                        isStuckHover ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}>
                        <span className="text-[9px] font-mono text-cyan-400/70 whitespace-nowrap">{badge.time}</span>
                      </div>
                      {/* Badge */}
                      <div
                        className={cn(
                          'border border-cyan-500/30 bg-cover bg-center',
                          isStuckHover
                            ? 'w-24 h-[72px] -translate-y-[calc(100%+4px)] shadow-[0_0_12px_rgba(34,211,238,0.4)] border-cyan-400/60 z-40 rounded-md'
                            : 'w-6 h-6 rounded-sm transition-all duration-200 ease-out group-hover:w-24 group-hover:h-[72px] group-hover:-translate-y-[calc(100%+4px)] group-hover:shadow-[0_0_12px_rgba(34,211,238,0.4)] group-hover:border-cyan-400/60 group-hover:z-40 group-hover:rounded-md',
                          inCut && 'opacity-50',
                        )}
                        style={{ backgroundImage: `url(${badge.src})` }}
                      />
                    </div>
                  );
                })}

                <div className="absolute top-0 pointer-events-none z-30" style={{ left: `${TRIM_PLAYHEAD_POS}%`, width: 3, height: 80, marginLeft: -1, backgroundColor: 'rgb(34, 211, 238)', filter: 'drop-shadow(0 0 6px rgba(34, 211, 238, 0.7))' }} />
              </div>
            </div>
          </div>
          <div className="relative w-[320px] shrink-0 flex flex-col border-l border-cyan-500/30 bg-gradient-to-b from-zinc-950 to-zinc-900/90">
            <div className="shrink-0 px-4 py-2.5 border-b border-zinc-700/50 bg-zinc-900/80 flex items-center justify-between">
              <span className="text-[10px] font-mono tracking-[0.25em] uppercase text-cyan-500/70">Transcript</span>
              <span className="text-[10px] font-mono text-zinc-500">25 words &middot; 8.9s</span>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 leading-relaxed scrollbar-hide">
              <div className="leading-loose">
                {trimDemoWords.map((word, i) => {
                  const isSelected = trimSelectedWordIndices.has(i);
                  const isActive = i === trimActiveWordIndex;
                  return (
                    <span key={i}>
                      <span className={cn('inline-block text-sm font-sans cursor-pointer select-none px-0.5 mx-0.5 my-0.5 rounded-sm', isSelected ? 'text-red-400/60 line-through decoration-red-500/80' : isActive ? 'text-cyan-300 bg-cyan-500/15' : 'text-zinc-300')}>{word.text}</span>
                      {word.text.endsWith('.') && <br />}
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="absolute bottom-3 right-3 z-10">
              <CommandButton command="/trim" icon={<Scissors className="w-5 h-5" />} size="lg" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Slide 8: Video Editing ──

function ClipViewer({ slug, activeRatio, children }: {
  slug: string;
  activeRatio: '9:16' | '16:9' | '1:1';
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col border border-zinc-600/50 rounded-xl overflow-hidden min-h-0">
      <div className="shrink-0 px-3 py-1 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between relative">
        <RatioToggle active={activeRatio} />
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] text-muted-foreground pointer-events-none">{slug}</span>
        <button className="w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-primary transition-colors duration-150 rounded hover:bg-black/40">
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 bg-black flex items-center justify-center min-h-0">
        {children}
      </div>
    </div>
  );
}

function Page8_VideoEditing() {
  return (
    <div className="w-full h-full flex flex-col gap-2">
      <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">ClipViewer</p>
      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-3 min-h-0 overflow-hidden">
        {/* Landscape — ready */}
        <ClipViewer slug="@hero" activeRatio="16:9">
          <video src="/fixtures/video-frost.mp4" className="w-full h-full object-contain" controls loop muted playsInline />
        </ClipViewer>
        {/* Portrait — empty */}
        <ClipViewer slug="@hero" activeRatio="9:16">
          <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Plus className="w-6 h-6" /><span className="text-xs">Create portrait render</span>
          </div>
        </ClipViewer>
        {/* Square — rendering */}
        <ClipViewer slug="@hero" activeRatio="1:1">
          <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" /><span className="text-xs">Rendering square...</span>
          </div>
        </ClipViewer>
        {/* Error */}
        <ClipViewer slug="@broken" activeRatio="16:9">
          <div className="flex flex-col items-center justify-center gap-1 text-destructive">
            <AlertTriangle className="w-6 h-6" /><span className="text-xs font-medium">Playback error</span>
          </div>
        </ClipViewer>
      </div>
    </div>
  );
}

// ── Slide 9: Audio System ──

function Page9_AudioSystem() {
  return (
    <div className="w-full h-full flex flex-col gap-5">
      {/* AudioPlayer */}
      <div className="shrink-0 border border-zinc-600/50 rounded-xl overflow-hidden bg-zinc-950 ring-1 ring-violet-500/10">
        <div className="shrink-0 px-5 py-2 border-b border-zinc-700/50 flex items-center justify-between bg-gradient-to-r from-zinc-900 to-zinc-950">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-foreground">@BACKGROUND-MUSIC</span>
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-violet-500/20 text-violet-400 border border-violet-500/30">VOCALS</span>
          </div>
          <div className="flex items-center gap-2">
            <CommandButton command="/trim-audio" icon={<Scissors className="w-3.5 h-3.5" />} />
            <CommandButton command="/isolate-vocals" icon={<Mic className="w-3.5 h-3.5" />} variant="violet" />
          </div>
        </div>
        <div className="relative px-5 py-3" style={{ minHeight: 100 }}>
          <div className="relative w-full" style={{ height: 60 }}>
            <StyleguideWaveform url="/fixtures/audio-storm.mp3" height={60} progress={0.4} />
            <div className="absolute top-0 bottom-0 left-0 bg-black/50 pointer-events-none" style={{ width: '15%' }} />
            <div className="absolute top-0 bottom-0 right-0 bg-black/50 pointer-events-none" style={{ width: '25%' }} />
            <div className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 z-30 pointer-events-none shadow-[0_0_6px_rgba(34,211,238,0.7)]" style={{ left: '40%' }} />
          </div>
        </div>
        <div className="px-5 py-2 border-t border-zinc-700/50 flex items-center gap-4 bg-zinc-900/60">
          <button className="w-8 h-8 rounded-full border border-primary/50 bg-primary/15 flex items-center justify-center text-primary"><Play className="w-3.5 h-3.5 ml-0.5" /></button>
          <div className="font-mono text-sm tabular-nums"><span className="text-cyan-400">01:23</span><span className="text-zinc-600 mx-1">/</span><span className="text-zinc-500">03:45</span></div>
        </div>
      </div>

      {/* AudioTrack states */}
      <div className="flex-1 min-h-0 p-5 rounded-xl bg-gradient-to-b from-zinc-950 to-zinc-900/60 border border-zinc-600/40 ring-1 ring-fuchsia-500/10 grid grid-cols-3 gap-4 content-start">
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2 uppercase tracking-widest">Empty (default)</p>
          <div className="border border-dashed rounded-md flex items-center justify-center gap-2 h-14 border-zinc-600/40 text-muted-foreground/40">
            <Music className="w-3.5 h-3.5" /><span className="font-mono text-xs">/add_audio</span>
          </div>
        </div>
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2 uppercase tracking-widest">Collapsed</p>
          <div className="border border-dashed rounded-md flex items-center justify-center gap-2 h-8 border-zinc-600/40 text-muted-foreground/40">
            <Music className="w-3 h-3" /><span className="font-mono text-[10px]">/add_audio</span>
          </div>
        </div>
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2 uppercase tracking-widest">Assigning</p>
          <div className="h-14 border border-zinc-700/40 bg-primary/5 rounded-md flex items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /><span className="font-mono text-xs tracking-wider">ASSIGNING...</span>
          </div>
        </div>
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2 uppercase tracking-widest">Active (cyan)</p>
          <div className="relative h-14 border border-cyan-400/30 bg-cyan-950/10 rounded-md overflow-hidden">
            <div className="absolute top-0 bottom-0 rounded border border-cyan-400/40 bg-cyan-950/30 overflow-hidden" style={{ left: '10%', width: '60%' }}>
              <div className="absolute inset-0 px-1 flex items-center"><StyleguideWaveform url="/fixtures/audio-red.mp3" height={36} waveColor="rgba(0, 255, 255, 0.3)" progressColor="rgba(0, 255, 255, 0.6)" /></div>
              <div className="absolute bottom-0.5 left-1 z-20"><span className="text-[10px] font-mono text-cyan-400/80 px-1 py-0.5 rounded bg-black/70">@bg-music</span></div>
            </div>
          </div>
        </div>
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2 uppercase tracking-widest">Active (magenta)</p>
          <div className="relative h-14 border border-fuchsia-400/30 bg-fuchsia-950/10 rounded-md overflow-hidden">
            <div className="absolute top-0 bottom-0 rounded border border-fuchsia-400/40 bg-fuchsia-950/30 overflow-hidden" style={{ left: '20%', width: '50%' }}>
              <div className="absolute inset-0 px-1 flex items-center"><StyleguideWaveform url="/fixtures/sfx-hit.mp3" height={36} waveColor="rgba(217, 70, 239, 0.3)" progressColor="rgba(217, 70, 239, 0.6)" /></div>
              <div className="absolute bottom-0.5 left-1 z-20"><span className="text-[10px] font-mono text-fuchsia-400/80 px-1 py-0.5 rounded bg-black/70">@sfx-hit</span></div>
            </div>
          </div>
        </div>
        <div>
          <p className="text-[11px] font-mono text-zinc-500 mb-2 uppercase tracking-widest">Multi-track</p>
          <div className="relative h-14 border border-zinc-700/30 bg-zinc-950/40 rounded-md overflow-hidden">
            <div className="absolute top-0 bottom-0 rounded border border-cyan-400/40 bg-cyan-950/30 overflow-hidden" style={{ left: '5%', width: '45%' }}>
              <div className="absolute inset-0 px-1 flex items-center"><StyleguideWaveform url="/fixtures/audio-red.mp3" height={36} waveColor="rgba(0, 255, 255, 0.3)" /></div>
              <div className="absolute bottom-0.5 left-1 z-20"><span className="text-[10px] font-mono text-cyan-400/80 px-1 py-0.5 rounded bg-black/70">@music</span></div>
            </div>
            <div className="absolute top-0 bottom-0 rounded border border-fuchsia-400/40 bg-fuchsia-950/30 overflow-hidden" style={{ left: '55%', width: '35%' }}>
              <div className="absolute inset-0 px-1 flex items-center"><StyleguideWaveform url="/fixtures/sfx-click.mp3" height={36} waveColor="rgba(217, 70, 239, 0.3)" /></div>
              <div className="absolute bottom-0.5 left-1 z-20"><span className="text-[10px] font-mono text-fuchsia-400/80 px-1 py-0.5 rounded bg-black/70">@vo</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* TimelineScrubber */}
      <div className="shrink-0 border border-zinc-600/50 rounded-xl overflow-hidden bg-zinc-950 ring-1 ring-amber-500/10">
        <div className="relative h-24 flex gap-0.5 bg-gradient-to-b from-zinc-900/40 to-zinc-950">
          <TimelineSlot label="@s01" hasContent thumbnailSrc="/styleguide-vid-purple-grind.jpg" assetId="vid-purple-grind" flex={3} />
          <TimelineSlot label="@s02" hasContent thumbnailSrc="/styleguide-img-neon-fox.jpg" assetId="vid-neon-fox" isActive flex={2} />
          <TimelineSlot label="@s03" hasContent thumbnailSrc="/styleguide-vid-sky-ghost.jpg" assetId="vid-sky-ghost" flex={3} />
          <TimelineSlot label="@s04" flex={2} />
          <div className="absolute top-0 bottom-0 w-0.5 bg-primary z-[100] pointer-events-none shadow-[0_0_8px_var(--color-primary)]" style={{ left: '42%' }} />
        </div>
        <div className="relative h-12 border-t border-zinc-700/50 bg-zinc-900/30">
          <div className="absolute top-0 bottom-0 rounded border border-cyan-400/40 bg-cyan-950/30 overflow-hidden" style={{ left: '8%', width: '55%' }}>
            <div className="absolute inset-0 px-1 flex items-center"><StyleguideWaveform url="/fixtures/audio-red.mp3" height={30} progress={0.42} /></div>
            <div className="absolute bottom-0.5 left-1 z-20"><span className="text-[10px] font-mono text-cyan-400/80 px-1 py-0.5 rounded bg-black/70">@bg-music</span></div>
          </div>
          <div className="absolute top-0 bottom-0 w-0.5 bg-primary z-[100] pointer-events-none shadow-[0_0_8px_var(--color-primary)]" style={{ left: '42%' }} />
        </div>
        <div className="border-t border-zinc-800/60">
          <div className="border border-dashed flex items-center justify-center gap-2 h-8 border-zinc-600/40 text-muted-foreground/40 m-0.5 rounded-md">
            <Music className="w-3 h-3" /><span className="font-mono text-[10px]">/add_audio</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Slide 10: Generation System ──

function Page10_GenSystem() {
  return (
    <div className="w-full h-full flex gap-8">
      {/* Left: Gen Panel variants */}
      <div className="flex-1 flex flex-col gap-4 min-h-0">
        <div className="flex gap-4 h-[220px] shrink-0">
          <div className="flex-1 flex flex-col gap-1">
            <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest">GenPanel — video</p>
            <div className="flex-1">
              <GenPanel label="VIDEO_GENERATION" icon={<Film className="w-5 h-5" />} onClose={genNoop} footer={<span className="font-mono text-xs text-primary/40">FOOTER_SLOT</span>}>
                <div className="flex-1 flex items-center justify-center"><span className="font-mono text-xs text-primary/30">FORM_FIELDS</span></div>
              </GenPanel>
            </div>
          </div>
          <div className="flex-1 flex flex-col gap-1">
            <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest">GenPanel — image</p>
            <div className="flex-1">
              <GenPanel label="IMAGE_GENERATION" icon={<ImageIcon className="w-5 h-5" />} onClose={genNoop} closeDisabled footer={<span className="font-mono text-xs text-primary/40">FOOTER_SLOT</span>}>
                <div className="flex-1 flex items-center justify-center"><span className="font-mono text-xs text-primary/30">FORM_FIELDS</span></div>
              </GenPanel>
            </div>
          </div>
        </div>
        {/* Composed demo */}
        <div className="flex-1 min-h-0">
          <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest mb-1">Composed GenPanel</p>
          <div className="h-[calc(100%-20px)]">
            <GenPanel label="VIDEO_GENERATION" icon={<Film className="w-5 h-5" />} onClose={genNoop} footer={
              <div className="flex items-center gap-4">
                <ModelSelector selectedModelKey="veo3_fast" modelOptions={mockModelOptions} onChange={genNoop} />
                <div className="flex-1" />
                <CommandButton command="/generate" icon={<Zap className="w-5 h-5" />} size="lg" state="ready" />
              </div>
            }>
              <div className="flex-1 pl-4 pr-8 py-4 overflow-y-auto">
                <div className="space-y-4">
                  <GenField label="Prompt" required actions={<CommandButton size="sm" command="/rewrite-prompt" icon={<Sparkles className="w-3 h-3" />} />}>
                    <GenTextarea value="A cinematic drone shot sweeping over a coastal city at golden hour" onChange={genNoop} rows={3} />
                  </GenField>
                  <div className="flex flex-wrap gap-x-6 gap-y-3">
                    <GenField label="Aspect Ratio"><GenToggle value="16:9" onChange={genNoop} options={['16:9', '9:16'] as const} /></GenField>
                    <GenField label="Duration"><GenToggle value="8" onChange={genNoop} options={['5', '8', '10'] as const} /></GenField>
                  </div>
                </div>
              </div>
            </GenPanel>
          </div>
        </div>
      </div>

      {/* Right: VideoSettingsModal */}
      <div className="w-[700px] shrink-0 flex flex-col min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest mb-1">Video Settings Modal</p>
        <div className="flex-1 overflow-y-auto relative rounded-lg border border-primary/40 bg-black/95 shadow-[0_0_30px_rgba(0,255,255,0.15)]" style={{ backgroundImage: 'linear-gradient(rgba(0,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,255,0.03) 1px, transparent 1px)', backgroundSize: '4px 4px' }}>
          <div className="scanlines pointer-events-none absolute inset-0 opacity-20" />
          <div className="relative px-6 pt-4 pb-2 border-b border-primary/20">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-primary/60 shadow-[0_0_8px_rgba(0,255,255,0.5)]" />
              <h3 className="text-sm font-mono font-bold text-primary tracking-[0.2em] uppercase">Render Settings</h3>
            </div>
          </div>
          <div className="relative px-6 py-4 space-y-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              <div className="space-y-4">
                {/* Orientation */}
                <div className="relative border border-primary/20 bg-black/50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2"><div className="w-0.5 h-3 bg-primary/50 rounded-full" /><span className="text-xs font-mono font-bold uppercase tracking-[0.15em] text-foreground">Orientations</span></div>
                  <div className="space-y-1.5">
                    {['Landscape', 'Portrait'].map((opt) => (
                      <label key={opt} className="flex items-center gap-2 cursor-pointer">
                        <div className="w-3.5 h-3.5 rounded-sm border flex items-center justify-center bg-primary/20 border-primary/50">
                          <svg className="w-2 h-2 text-primary" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="2 6 5 9 10 3" /></svg>
                        </div>
                        <span className="text-sm text-foreground">{opt}</span>
                      </label>
                    ))}
                  </div>
                </div>
                {/* Subtitles */}
                <div className="relative border border-primary/20 bg-black/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2"><div className="w-0.5 h-3 bg-primary/50 rounded-full" /><span className="text-xs font-mono font-bold uppercase tracking-[0.15em] text-foreground">Subtitles</span></div>
                    <button className="px-2 py-0.5 text-[10px] font-bold bg-primary/25 border border-primary/50 text-primary rounded">ON</button>
                  </div>
                  <div className="space-y-2">
                    <div><span className="text-xs text-muted-foreground block mb-1">Style</span><div className="flex gap-1.5">{['TikDance', 'Highlight'].map((o, i) => <button key={o} className={cn('flex-1 px-2 py-1 text-xs border rounded-sm', i === 0 ? 'bg-primary/20 border-primary/50 text-primary' : 'bg-black/40 border-white/10 text-muted-foreground')}>{o}</button>)}</div></div>
                    <div><span className="text-xs text-muted-foreground block mb-1">Position</span><div className="flex gap-1.5">{['Top', 'Mid', 'Bottom'].map((o, i) => <button key={o} className={cn('flex-1 px-2 py-1 text-xs border rounded-sm', i === 2 ? 'bg-primary/20 border-primary/50 text-primary' : 'bg-black/40 border-white/10 text-muted-foreground')}>{o}</button>)}</div></div>
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                {/* Audio */}
                <div className="relative border border-primary/20 bg-black/50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2"><div className="w-0.5 h-3 bg-primary/50 rounded-full" /><span className="text-xs font-mono font-bold uppercase tracking-[0.15em] text-foreground">Audio</span></div>
                  <div className="space-y-2">
                    {[{ l: 'Fade In', v: 250 }, { l: 'Fade Out', v: 1000 }, { l: 'Volume', v: 60 }].map((f) => (
                      <div key={f.l} className="flex items-center gap-2">
                        <span className="text-xs w-14 shrink-0 text-muted-foreground">{f.l}</span>
                        <input type="number" defaultValue={f.v} readOnly className="flex-1 bg-black/50 border border-white/15 text-xs font-mono px-2 py-1 rounded-md" />
                      </div>
                    ))}
                  </div>
                </div>
                {/* OSG */}
                <div className="relative border border-primary/20 bg-black/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2"><div className="w-0.5 h-3 bg-primary/50 rounded-full" /><span className="text-xs font-mono font-bold uppercase tracking-[0.15em] text-foreground">OSG</span></div>
                    <button className="px-2 py-0.5 text-[10px] font-bold bg-primary/25 border border-primary/50 text-primary rounded">ON</button>
                  </div>
                  <div className="space-y-2">
                    <div><span className="text-xs text-muted-foreground block mb-1">Position</span><div className="grid grid-cols-2 gap-1.5">{['TL', 'TR', 'BL', 'BR'].map((p, i) => <button key={p} className={cn('px-2 py-1 text-[10px] border rounded-sm', i === 1 ? 'bg-primary/20 border-primary/50 text-primary' : 'bg-black/40 border-white/15 text-muted-foreground')}>{p}</button>)}</div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="relative px-6 py-3 border-t border-primary/20">
            <CommandButton command="/apply" icon={<Check className="w-5 h-5" />} size="lg" className="w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Slide 11: Workflow ──

function Page11_Workflow() {
  return (
    <div className="w-full h-full flex flex-col gap-6">
      {/* Top row: Sidebars + Inbox */}
      <div className="flex gap-6 h-[440px] shrink-0">
        {/* CollapsibleSidebar states */}
        <div className="flex-1 flex flex-col gap-2">
          <h3 className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest">CollapsibleSidebar</h3>
          <div className="flex-1 grid grid-cols-4 gap-4 min-h-0">
            <div className="flex flex-col gap-1 min-h-0">
              <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">left expanded</p>
              <div className="flex-1 border border-zinc-700/50 rounded-lg overflow-hidden flex min-h-0">
                <CollapsibleSidebar side="left" collapsed={false} onToggle={() => {}} expandedWidth="100%">
                  <SidebarHeader icon={<Film className="w-4 h-4" />} title="CLIPS" collapsed={false} onToggle={() => {}} side="left" sortOrder="newest" onSortChange={() => {}} />
                  <div className="flex-1 flex items-center justify-center"><span className="font-mono text-[10px] text-muted-foreground/40">CARD_LIST</span></div>
                </CollapsibleSidebar>
              </div>
            </div>
            <div className="flex flex-col gap-1 min-h-0">
              <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">left collapsed</p>
              <div className="flex-1 border border-zinc-700/50 rounded-lg overflow-hidden flex min-h-0">
                <CollapsibleSidebar side="left" collapsed={true} onToggle={() => {}}>
                  <SidebarHeader icon={<Film className="w-4 h-4" />} title="CLIPS" collapsed={true} onToggle={() => {}} side="left" />
                </CollapsibleSidebar>
              </div>
            </div>
            <div className="flex flex-col gap-1 min-h-0">
              <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">right expanded</p>
              <div className="flex-1 border border-zinc-700/50 rounded-lg overflow-hidden flex justify-end min-h-0">
                <CollapsibleSidebar side="right" collapsed={false} onToggle={() => {}} expandedWidth="100%">
                  <SidebarHeader icon={<AudioLines className="w-4 h-4" />} title="AUDIO" collapsed={false} onToggle={() => {}} side="right" />
                  <div className="flex-1 flex items-center justify-center"><span className="font-mono text-[10px] text-muted-foreground/40">CARD_LIST</span></div>
                </CollapsibleSidebar>
              </div>
            </div>
            <div className="flex flex-col gap-1 min-h-0">
              <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">right collapsed</p>
              <div className="flex-1 border border-zinc-700/50 rounded-lg overflow-hidden flex justify-end min-h-0">
                <CollapsibleSidebar side="right" collapsed={true} onToggle={() => {}}>
                  <SidebarHeader icon={<AudioLines className="w-4 h-4" />} title="AUDIO" collapsed={true} onToggle={() => {}} side="right" />
                </CollapsibleSidebar>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom: Chat & Messaging */}
      <div className="flex-1 min-h-0 flex flex-col gap-4">
        <h3 className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">Chat & Messaging</h3>
        <div className="flex-1 flex gap-6 min-h-0">
          {/* ScriptReadout */}
          <div className="flex-1 flex gap-4 min-h-0">
            <div className="flex-1 flex flex-col gap-1 min-h-0">
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider shrink-0">with content</span>
              <div className="flex-1 min-h-0">
                <ScriptReadout content={sampleScript} slug="@hero-script" onSave={() => {}} onGenerateVideo={() => {}} />
              </div>
            </div>
            <div className="flex-1 flex flex-col gap-1 min-h-0">
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider shrink-0">generating video</span>
              <div className="flex-1 min-h-0">
                <ScriptReadout content={sampleScript} slug="@render-script" isGenerating onSave={() => {}} onGenerateVideo={() => {}} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Slide 12: Command System ──

const mockProjects = [
  { slug: 'summer-campaign', active: false },
  { slug: 'prod', active: true },
  { slug: 'brand-refresh', active: false },
  { slug: 'q4-video-ads', active: false },
];

const mockCommands: CommandDescriptor[] = [
  { command: '/generate', description: 'Generate content from prompt', example: '/generate video of a dog on a skateboard @bg-neon', category: 'action', icon: 'Zap', size: 'lg', variant: 'default', chevron: 'right', params: [] },
  { command: '/rewrite-prompt', description: 'Optimize a prompt', example: '/rewrite-prompt "make it more cinematic"', category: 'action', icon: 'Sparkles', size: 'sm', variant: 'default', chevron: 'right', params: [] },
  { command: '/trim', description: 'Trim video clip', example: '/trim @hero-intro 0:05 0:12', category: 'action', icon: 'Scissors', size: 'lg', variant: 'default', chevron: 'right', params: [] },
  { command: '/isolate-vocals', description: 'Isolate vocals from audio', example: '/isolate-vocals @voiceover-main', category: 'action', icon: 'Mic', size: 'default', variant: 'violet', chevron: 'right', params: [] },
  { command: '/inbox', description: 'View generations inbox', example: '/inbox', category: 'action', icon: 'Mailbox', size: 'default', variant: 'default', chevron: 'down', params: [] },
];
const mockAssetSlugs = ['@hero-intro', '@product-shot', '@bg-neon', '@outro-clip', '@voiceover-main'];

function Page12_CommandSystem() {
  return (
    <div className="w-full h-full flex flex-col gap-5">
      {/* Row 1: ProjectButton + ProjectDropdown + InboxButton */}
      <div className="flex gap-6 shrink-0">
        {/* ProjectButton */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[11px] font-mono text-zinc-500 tracking-widest">ProjectButton</h3>
          </div>
          <ProjectButton projectSlug="prod" />
        </div>

        {/* ProjectDropdown — Open */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-mono text-zinc-500 tracking-widest">ProjectDropdown — Open</h3>
          <div className="rounded-md border border-emerald-500/25 bg-card w-56 overflow-hidden">
            <div className="py-1">
              {mockProjects.map((p) => (
                <div
                  key={p.slug}
                  className={cn(
                    'group/row flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors',
                    'hover:bg-emerald-500/10',
                    p.active && 'bg-emerald-500/5'
                  )}
                >
                  <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', p.active ? 'bg-emerald-400' : 'bg-transparent')} />
                  <span className="font-mono text-xs tracking-wide text-emerald-400/80 flex-1 truncate">{p.slug}</span>
                  <button className="p-1 opacity-0 group-hover/row:opacity-100 text-muted-foreground hover:text-foreground transition-all">
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
            <div className="border-t border-emerald-500/20" />
            <div className="py-1">
              <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-emerald-500/10 transition-colors">
                <Plus className="w-3.5 h-3.5 text-emerald-400/60" />
                <span className="font-mono text-xs tracking-wide text-emerald-400/60">New Project</span>
              </div>
            </div>
          </div>
        </div>

        {/* ProjectDropdown — Rename */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-mono text-zinc-500 tracking-widest">ProjectDropdown — Rename</h3>
          <div className="rounded-md border border-emerald-500/25 bg-card w-56 overflow-hidden">
            <div className="py-1">
              <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-emerald-500/10">
                <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-transparent" />
                <span className="font-mono text-xs tracking-wide text-emerald-400/80 flex-1 truncate">summer-campaign</span>
              </div>
              <div className="flex items-center gap-1 px-2 py-1">
                <Input defaultValue="prod-v2" className="h-7 text-xs font-mono flex-1" />
                <button className="p-1 text-green-400 hover:text-green-300 transition-colors"><Check className="w-3.5 h-3.5" /></button>
                <button className="p-1 text-red-400 hover:text-red-300 transition-colors"><X className="w-3.5 h-3.5" /></button>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-emerald-500/10">
                <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-transparent" />
                <span className="font-mono text-xs tracking-wide text-emerald-400/80 flex-1 truncate">brand-refresh</span>
              </div>
            </div>
            <div className="border-t border-emerald-500/20" />
            <div className="py-1">
              <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-emerald-500/10">
                <Plus className="w-3.5 h-3.5 text-emerald-400/60" />
                <span className="font-mono text-xs tracking-wide text-emerald-400/60">New Project</span>
              </div>
            </div>
          </div>
        </div>

        {/* ProjectDropdown — New */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-mono text-zinc-500 tracking-widest">ProjectDropdown — New</h3>
          <div className="rounded-md border border-emerald-500/25 bg-card w-56 overflow-hidden">
            <div className="py-1">
              {mockProjects.slice(0, 2).map((p) => (
                <div key={p.slug} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-emerald-500/10">
                  <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', p.active ? 'bg-emerald-400' : 'bg-transparent')} />
                  <span className="font-mono text-xs tracking-wide text-emerald-400/80 flex-1 truncate">{p.slug}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-emerald-500/20" />
            <div className="py-1">
              <div className="flex items-center gap-1 px-2 py-1">
                <Input defaultValue="holiday-promo" placeholder="project-slug" className="h-7 text-xs font-mono flex-1" />
                <button className="p-1 text-green-400 hover:text-green-300 transition-colors"><Check className="w-3.5 h-3.5" /></button>
                <button className="p-1 text-red-400 hover:text-red-300 transition-colors"><X className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          </div>
        </div>

        {/* InboxButton + InboxDrawer tiles */}
        <div className="flex flex-col gap-2 ml-auto">
          <h3 className="text-[11px] font-mono text-zinc-500 tracking-widest">InboxButton</h3>
          <div className="flex gap-4">
            {pendingGenButtonStates.map((s) => (
              <div key={s.label} className="flex flex-col items-center gap-1">
                <InboxButton state={s.state} generatingCount={s.generatingCount} readyCount={s.readyCount} flashKey={0} onClick={() => {}} />
                <span className="text-[9px] font-mono text-muted-foreground">{s.label}</span>
              </div>
            ))}
          </div>
          <h3 className="text-[11px] font-mono text-zinc-500 tracking-widest mt-2">InboxDrawer — Review Tiles</h3>
          <div className="grid grid-cols-2 gap-3 min-h-0">
            <div className="rounded-lg border border-primary/60 bg-card/95 shadow-[0_0_15px_rgba(0,255,255,0.15)] overflow-hidden flex flex-col min-h-0">
              <div className="aspect-video bg-black relative shrink-0"><img src="/styleguide-vid-purple-grind.jpg" alt="" className="w-full h-full object-cover" /></div>
              <div className="flex items-center gap-2 px-2 py-1 text-[10px] font-mono text-muted-foreground"><span className="text-primary/70 truncate">@hero-intro</span><span className="shrink-0">veo3</span></div>
              <div className="flex border-t border-border/50 mt-auto">
                <div className="flex-1 flex items-center justify-center gap-1 py-2 text-[10px] font-mono font-bold text-red-400 border-r border-border/50"><X className="w-3 h-3" />REJECT</div>
                <div className="flex-1 flex items-center justify-center gap-1 py-2 text-[10px] font-mono font-bold text-primary"><Check className="w-3 h-3" />APPROVE</div>
              </div>
            </div>
            <div className="rounded-lg border border-border/20 bg-card/60 opacity-60 overflow-hidden flex flex-col min-h-0">
              <div className="aspect-video bg-black relative shrink-0"><img src="/styleguide-vid-turret-cyber.jpg" alt="" className="w-full h-full object-cover" /></div>
              <div className="flex items-center gap-2 px-2 py-1 text-[10px] font-mono text-muted-foreground"><span className="text-primary/70 truncate">@product-shot</span><span className="shrink-0">kling3</span></div>
              <div className="flex border-t border-border/50 mt-auto">
                <div className="flex-1 flex items-center justify-center gap-1 py-2 text-[10px] font-mono font-bold text-red-400 border-r border-border/50"><X className="w-3 h-3" />REJECT</div>
                <div className="flex-1 flex items-center justify-center gap-1 py-2 text-[10px] font-mono font-bold text-primary"><Check className="w-3 h-3" />APPROVE</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Row 2: CommandButton + AutocompleteDropdown */}
      <div className="flex-1 min-h-0 flex flex-col gap-2">
        <div className="flex items-baseline gap-6">
          <h3 className="text-[11px] font-mono text-zinc-500 tracking-widest">CommandButton</h3>
          <h3 className="text-[11px] font-mono text-zinc-500 tracking-widest ml-auto">AutocompleteDropdown</h3>
        </div>
        <div className="flex gap-8 flex-1 min-h-0">
          {/* Sizes */}
          <div className="flex flex-col gap-3">
            <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">sizes</p>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground/60 w-14 shrink-0">sm</span>
                <CommandButton size="sm" command="/rewrite-prompt" icon={<Sparkles className="w-3 h-3" />} />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground/60 w-14 shrink-0">default</span>
                <CommandButton command="/final" icon={<Clapperboard className="w-3.5 h-3.5" />} />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground/60 w-14 shrink-0">lg</span>
                <CommandButton command="/generate" icon={<Zap className="w-5 h-5" />} size="lg" />
              </div>
            </div>
          </div>

          {/* Variants */}
          <div className="flex flex-col gap-3">
            <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">variants</p>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground/60 w-14 shrink-0">default</span>
                <CommandButton command="/trim-audio" icon={<Scissors className="w-3.5 h-3.5" />} />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground/60 w-14 shrink-0">violet</span>
                <CommandButton command="/isolate-vocals" icon={<Mic className="w-3.5 h-3.5" />} variant="violet" />
              </div>
            </div>
          </div>

          {/* Chevrons */}
          <div className="flex flex-col gap-3">
            <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">chevrons</p>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground/60 w-14 shrink-0">right</span>
                <CommandButton command="/generate" icon={<Zap className="w-3.5 h-3.5" />} />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground/60 w-14 shrink-0">down</span>
                <CommandButton command="/inbox" icon={<FolderOpen className="w-3.5 h-3.5" />} chevron="down" />
              </div>
            </div>
          </div>

          {/* States (lg) */}
          <div className="flex flex-col gap-3">
            <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">states (lg)</p>
            <ExecuteButtonStatesDemo />
          </div>

          {/* /command autocomplete */}
          <div className="flex flex-col gap-1 flex-1 min-w-0 justify-end">
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">/command</span>
            <div className="relative">
              <AutocompleteDropdown
                items={mockCommands.map((s) => ({
                  type: 'command' as const,
                  value: s.command,
                  label: s.command,
                  description: s.description,
                  example: s.example,
                  category: s.category,
                  icon: s.icon,
                  colorScheme: 'cyan' as const,
                }))}
                selectedIndex={1}
                onSelect={() => {}}
                onHover={() => {}}
              />
              <ChatInput commands={mockCommands} assetSlugs={mockAssetSlugs} />
            </div>
          </div>

          {/* @slug autocomplete */}
          <div className="flex flex-col gap-1 flex-1 min-w-0 justify-end">
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">@slug</span>
            <div className="relative">
              <AutocompleteDropdown
                items={mockAssetSlugs.map((slug) => ({
                  type: 'slug' as const,
                  value: slug,
                  label: slug,
                  description: '',
                  colorScheme: 'cyan' as const,
                }))}
                selectedIndex={2}
                onSelect={() => {}}
                onHover={() => {}}
              />
              <ChatInput commands={mockCommands} assetSlugs={mockAssetSlugs} />
            </div>
          </div>
        </div>
      </div>

      {/* Row 4: ChatInput States */}
      <div className="shrink-0 flex flex-col gap-2">
        <h3 className="text-[11px] font-mono text-zinc-500 tracking-widest">ChatInput</h3>
        <div className="grid grid-cols-4 gap-4">
          <div className="flex flex-col gap-1"><span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">default</span><ChatInput commands={mockCommands} assetSlugs={mockAssetSlugs} /></div>
          <div className="flex flex-col gap-1"><span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">loading</span><ChatInput isLoading commands={mockCommands} assetSlugs={mockAssetSlugs} /></div>
          <div className="flex flex-col gap-1"><span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">transmitting</span><ChatInput isTransmitting commands={mockCommands} assetSlugs={mockAssetSlugs} /></div>
          <div className="flex flex-col gap-1"><span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">disabled</span><ChatInput disabled commands={mockCommands} assetSlugs={mockAssetSlugs} /></div>
        </div>
      </div>
    </div>
  );
}

function Page13_InboxReview() {
  const activeIndex = 2; // 3rd tile is active (0-based)
  return (
    <div className="w-full h-full flex flex-col bg-background">
      {/* ReviewHeader */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
        <span className="text-xs font-mono font-bold tracking-widest text-primary/70 uppercase">REVIEW_QUEUE</span>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-muted-foreground">{activeIndex + 1}/{reviewQueueItems.length}</span>
          <button className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-wrap gap-4">
          {reviewQueueItems.map((item, i) => {
            const isActive = i === activeIndex;
            const durationLabel = item.durationSeconds != null
              ? `0:${String(item.durationSeconds).padStart(2, '0')}`
              : null;
            const w = item.width ?? 1920;
            const h = item.height ?? 1080;
            const isPortrait = h > w;
            const isSquare = w === h;
            const ratioLabel = isPortrait ? '9:16' : isSquare ? '1:1' : '16:9';
            const cardWidth = isPortrait ? 'w-[160px]' : isSquare ? 'w-[220px]' : 'w-[300px]';
            return (
              <div
                key={item.id}
                className={cn(
                  cardWidth,
                  'rounded-lg overflow-hidden flex flex-col transition-all duration-300 shrink-0',
                  isActive
                    ? 'border border-primary/60 bg-card/95 shadow-[0_0_15px_rgba(0,255,255,0.15)]'
                    : 'border border-border/20 bg-card/60 opacity-60'
                )}
              >
                <div className="bg-black relative" style={{ aspectRatio: `${w}/${h}` }}>
                  <img src={item.thumbnailSrc ?? ''} alt="" className="w-full h-full object-cover" />
                </div>
                <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-muted-foreground mt-auto">
                  <span className="text-primary/70 truncate">{item.slug}</span>
                  {durationLabel && (
                    <>
                      <span className="text-border">&middot;</span>
                      <span className="shrink-0">{durationLabel}</span>
                    </>
                  )}
                  {item.origin && (
                    <>
                      <span className="text-border">&middot;</span>
                      <span className="shrink-0">{item.origin}</span>
                    </>
                  )}
                  <span className="text-border">&middot;</span>
                  <span className={cn(
                    'shrink-0 text-[10px] px-1 rounded',
                    isPortrait ? 'bg-violet-500/15 text-violet-400/80'
                      : isSquare ? 'bg-amber-500/15 text-amber-400/80'
                      : 'bg-primary/10 text-primary/60'
                  )}>{ratioLabel}</span>
                </div>
                <div className="flex border-t border-border/50">
                  <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-red-400 border-r border-border/50">
                    <X className="w-3.5 h-3.5" />REJECT
                  </div>
                  <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-primary">
                    <Check className="w-3.5 h-3.5" />APPROVE
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* PendingSection */}
      <div className="border-t border-border/50 shrink-0">
        <div className="flex items-center gap-2 px-6 py-2">
          <span className="text-[10px] font-mono font-bold tracking-widest text-amber-500/70 uppercase">INCOMING</span>
          <span className="text-[10px] font-mono text-muted-foreground">{pendingQueueItems.length}</span>
        </div>
        <div className="max-h-32 overflow-y-auto px-6 pb-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {pendingQueueItems.map((item) => (
            <div key={item.id} className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin text-amber-500/60 shrink-0" />
              <span className="truncate text-foreground/70">{item.slug}</span>
              <span className="text-[10px] bg-amber-500/15 text-amber-500/70 px-1.5 rounded shrink-0">{item.tag}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Slide 14: Asset Viewer ──

const assetViewerMockImage: MediaItem = {
  id: 'img-neon-fox',
  type: 'image',
  slug: '@img-neon-fox',
  title: 'Neon Fox',
  status: 'ready',
  filePath: '/styleguide-img-neon-fox.jpg',
};

const assetViewerMockVideo: MediaItem = {
  id: 'vid-aurora-sky',
  type: 'video',
  slug: '@vid-aurora-sky',
  title: 'Aurora Sky',
  status: 'ready',
  filePath: '/fixtures/video-frost.mp4',
  thumbnailSrc: '/styleguide-img-cover.jpg',
};

function Page14_AssetViewer() {
  return (
    <div className="w-full h-full grid grid-cols-2 gap-6">
      {/* Left: Landscape viewer */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">ImageViewer — Landscape</p>
        <div className="flex-1 overflow-hidden flex min-h-0">
          <AssetViewer item={assetViewerMockImage} projectSlug="demo" size="landscape" onSizeChange={() => {}} flipped={false} onFlippedChange={() => {}} renderOrientations={['landscape']} videoAssetCount={0} onAddOrientation={() => {}} />
        </div>
      </div>
      {/* Right: Portrait viewer */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">ImageViewer — Portrait</p>
        <div className="flex-1 overflow-hidden flex min-h-0">
          <AssetViewer item={assetViewerMockVideo} projectSlug="demo" size="portrait" onSizeChange={() => {}} flipped={false} onFlippedChange={() => {}} renderOrientations={['landscape', 'portrait']} videoAssetCount={0} onAddOrientation={() => {}} />
        </div>
      </div>
    </div>
  );
}

// ── Slide 15: Git History ──

function Page15_GitHistory() {
  const headCommit = mockCommits[0];
  const headOp = extractOperation(headCommit.message);
  return (
    <div className="w-full h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-3">
          <History className="w-4 h-4 text-primary/70" />
          <span className="text-xs font-mono font-bold tracking-widest text-primary/70 uppercase">ASSET_HISTORY</span>
          <span className="text-xs font-mono text-muted-foreground/60">vid-hero-intro</span>
        </div>
        <button className="text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Two-panel body */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel — asset info */}
        <div className="w-[280px] shrink-0 border-r border-border/50 flex flex-col gap-6 px-6 py-6">
          {/* Thumbnail */}
          <div className="w-full aspect-video rounded-lg overflow-hidden bg-card border border-border/30">
            <img src="/styleguide-vid-purple-grind.jpg" alt="" className="w-full h-full object-cover" />
          </div>

          <div className="flex flex-col gap-4">
            <MetaRow label="ASSET_ID">vid-hero-intro</MetaRow>
            <MetaRow label="TYPE">
              <span className="flex items-center gap-1.5">
                <Film className="w-3.5 h-3.5 text-primary/60" />
                VIDEO
              </span>
            </MetaRow>
            <MetaRow label="COMMITS">{mockCommits.length}</MetaRow>
            <MetaRow label="CREATED">3/10</MetaRow>
            <MetaRow label="MODIFIED">18m ago</MetaRow>
          </div>

          {/* Active version card */}
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 shadow-[0_0_12px_rgba(0,212,255,0.08)]">
            <span className="text-[10px] font-mono font-bold tracking-widest text-primary/50 uppercase">ACTIVE_VER</span>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-sm font-mono text-primary/90 font-bold">{headCommit.hash}</span>
              <span className={cn('text-xs font-mono', OPERATION_STYLES[headOp].label)}>{headOp}</span>
            </div>
          </div>
        </div>

        {/* Right panel — commit log */}
        <div className="flex-1 flex flex-col min-h-0 px-6 py-6">
          <div className="flex items-baseline gap-3 mb-4 shrink-0">
            <span className="text-xs font-mono font-bold tracking-widest text-muted-foreground/70 uppercase">COMMIT_LOG</span>
            <span className="text-[11px] font-mono text-muted-foreground/40">&middot; {mockCommits.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {mockCommits.map((commit, i) => (
              <TimelineNode key={commit.hash} commit={commit} isHead={i === 0} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Slide Pages Array ──

const SLIDE_PAGES = [
  Page1_FinalVideoPreview,
  Page2_VideoGeneration,
  Page7_Trimming,
  Page3_MediaCatalog,
  Page4_DesignSystem,
  Page5_FormsControls,
  Page6_CenterStage,
  Page8_VideoEditing,
  Page9_AudioSystem,
  Page10_GenSystem,
  Page11_Workflow,
  Page12_CommandSystem,
  Page13_InboxReview,
  Page14_AssetViewer,
  Page15_GitHistory,
];

// ── Main Styleguide ──

export function Styleguide() {
  const scale = useSlideScale();
  const { currentSlide, next, prev } = useSlideNavigation(SLIDE_PAGES.length);
  const total = SLIDE_PAGES.length;

  return (
    <div
      className="w-screen h-screen overflow-hidden relative flex items-center justify-center"
      style={{
        backgroundColor: '#0a0c10',
        backgroundImage: 'radial-gradient(circle, rgba(0,212,255,0.08) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    >
      <Toaster />
      {/* Scaled wrapper — sized to visual dimensions so flex-centering works without clipping */}
      <div
        style={{
          width: 1920 * scale,
          height: 1080 * scale,
        }}
      >
        {/* 1080p slide area */}
        <div className="relative" style={{ width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          {SLIDE_PAGES.map((PageComponent, i) => (
            <div
              key={i}
              className="absolute top-0 left-0 transition-opacity duration-500"
              style={{
                opacity: i === currentSlide ? 1 : 0,
                pointerEvents: i === currentSlide ? 'auto' : 'none',
              }}
            >
              <Slide>
                <PageComponent />
              </Slide>
            </div>
          ))}
        </div>
      </div>
      {/* Fixed page counter — outside scaled wrapper, bottom-right of viewport */}
      <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5 font-mono text-[11px] text-primary/40 select-none">
        {currentSlide > 0 ? (
          <button onClick={prev} className="pointer-events-auto hover:text-primary/70 transition-colors">&larr;</button>
        ) : (
          <span className="invisible">&larr;</span>
        )}
        <span>{currentSlide + 1}/{total}</span>
        {currentSlide < total - 1 ? (
          <button onClick={next} className="pointer-events-auto hover:text-primary/70 transition-colors">&rarr;</button>
        ) : (
          <span className="invisible">&rarr;</span>
        )}
      </div>
    </div>
  );
}
