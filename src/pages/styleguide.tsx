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
import { AssetViewShell, IdleScreen, RenderingReadout, AssetViewer, FileListPane, FileContentPane } from '@/components/center-stage';
import type { ManifestFile } from '@/components/center-stage';
import { RenderSettingsPanel } from '@/components/center-stage/RenderSettingsPanel';
import { HistoryListPane, HistoryDetailPane } from '@/components/center-stage/GitHistoryPanel';
import type { GitCommit } from '@/hooks/useAssetHistory';
import { DEFAULT_RENDER_SETTINGS } from '@/components/center-stage/render-settings-types';
import { MountKeyProvider } from '@/contexts/MountKeyContext';
import { ScriptReadout } from '@/components/chat/ScriptReadout';
import { SidebarHeader } from '@/components/sidebar/SidebarHeader';
import { CollapsibleSidebar } from '@/components/sidebar/CollapsibleSidebar';
import { CloseButton } from '@/components/gen/ui';
import type { MediaItem } from '@/components/sidebar/types';
import { TimelineSlot } from '@/components/timeline/TimelineSlot';
import { TimelinePlayer } from '@/components/center-stage/TimelinePlayer';
import type { TimelinePreviewData } from '@/components/center-stage/TimelinePlayer';
import type { Orientation } from '@/hooks/useTimeline';
import { UploadSlot } from '@/components/sidebar/UploadSlot';
import {
  FolderOpen, X, Download, Sparkles,
  Film, Grid3x3, Scissors, Music, Clapperboard, Eraser, Magnet,
  Zap, Info, Settings, User, Copy, Trash2,
  AudioLines, Plus, Pencil,
  Loader2, Mic,
  Check, RotateCcw,
} from 'lucide-react';
import { ProjectButton } from '@/components/layout/ProjectButton';
import { HomeHeaderBar } from '@/components/layout/HomeHeaderBar';
import { AssetMenu } from '@/components/sidebar/menus/AssetMenu';
import { GenPanel } from '@/components/gen/ui/GenPanel';
import { ModelSelector } from '@/components/gen/ui/ModelSelector';
import { ImageParamSlots } from '@/components/gen/ImageParamSlots';
import type { ModelOption, ResolvedAsset } from '@/components/gen/types';
import type { UseMcpResult } from 'use-mcp/react';

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


// Demo waveform — pseudo-random 100-bar sine envelope for styleguide slots
const DEMO_WAVEFORM = Array.from({ length: 100 }, (_, i) => {
  const env = 0.3 + 0.7 * Math.sin((i / 100) * Math.PI);
  const noise = (Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1;
  return Math.abs(noise) * env * 0.9 + 0.1;
});

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
  { item: { id: 'o-img-ready', type: 'image', slug: '@product-hero', title: 'Product Hero', filePath: '/styleguide-img-cyber-fresh.jpg', status: 'ready', width: 1920, height: 1080, origin: 'nano_banana', thumbnailSrc: '/styleguide-img-cyber-fresh.jpg' }, Component: ImageCard },
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

const pendingQueueItems: MediaItem[] = [
  { id: 'pq-1', type: 'video', slug: '@intro-v2', title: 'Intro V2', filePath: '', status: 'generating', width: 1920, height: 1080, origin: 'veo3', thumbnailSrc: '/styleguide-vid-purple-grind.jpg', prompt: 'cinematic intro with neon lights' },
  { id: 'pq-2', type: 'video', slug: '@b-roll-city', title: 'B-Roll City', filePath: '', status: 'downloading', width: 1080, height: 1920, origin: 'kling3', thumbnailSrc: null, prompt: 'aerial city flyover at night' },
  { id: 'pq-3', type: 'video', slug: '@cta-end', title: 'CTA End', filePath: '', status: 'generating', width: 1080, height: 1080, origin: 'wan21', thumbnailSrc: null, prompt: 'call to action end screen' },
  { id: 'pq-4', type: 'video', slug: '@ambient-loop', title: 'Ambient Loop', filePath: '', status: 'generating', width: 1920, height: 1080, origin: 'veo3', thumbnailSrc: '/styleguide-vid-sky-ghost.jpg', prompt: 'ambient background loop' },
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

const styleguideMockCallTool: UseMcpResult['callTool'] = async (name: string) => {
  if (name === 'list_projects') {
    return {
      content: [{ type: 'text', text: JSON.stringify([
        { slug: 'vax', path: '/projects/vax' },
        { slug: 'neon-reel', path: '/projects/neon-reel' },
        { slug: 'demo-2025', path: '/projects/demo-2025' },
      ]) }],
    };
  }
  return { content: [{ type: 'text', text: '{}' }] };
};

function clipMenu(slug: string, itemType: string) {
  return (
    <AssetMenu slug={slug} itemType={itemType} onShowFolder={() => {}} MenuItem={ContextMenuItem} />
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

const page2ModelOptions: ModelOption[] = [
  { key: 'kling3', label: 'Kling 3.0', tool_name: 'generate_kling30_video', description: 'Kling 3.0 video generation', schema: { type: 'object', properties: {}, required: [] }, prefilled_values: {}, validation: { valid: true, missing_required: [], warnings: [] } },
  { key: 'veo3', label: 'Veo 3', tool_name: 'generate_veo3_video', description: 'Veo 3 video generation', schema: { type: 'object', properties: {}, required: [] }, prefilled_values: {}, validation: { valid: true, missing_required: [], warnings: [] } },
  { key: 'wan21', label: 'Wan 2.1', tool_name: 'generate_wan21_video', description: 'Wan 2.1 video generation', schema: { type: 'object', properties: {}, required: [] }, prefilled_values: {}, validation: { valid: true, missing_required: [], warnings: [] } },
];

const page2ResolvedAssets: ResolvedAsset[] = [
  { slug: '@img-neon-fox', src: '/styleguide-img-neon-fox.jpg', thumbnailSrc: '/styleguide-img-neon-fox.jpg', type: 'image' },
];

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

// Active word index (currently playing)
const trimActiveWordIndex = 11;

// Trim selection range (violet overlay with handles) — matches TrimEditor's TrimRange
const trimDemoRange = { startPct: 18, endPct: 30 };

// Duration for time marks (matches last word end time)
const TRIM_DEMO_DURATION = 8.9;

const trimTimelineBadges = Array.from({ length: 6 }, (_, i) => ({
  percent: ((i + 0.5) / 6) * 100,
  src: i % 2 === 0 ? '/styleguide-img-cover.jpg' : '/styleguide-vid-purple-grind.jpg',
  time: `0:${Math.round(((i + 0.5) / 6) * 10).toString().padStart(2, '0')}`,
}));

function formatTrimTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}


// ── Player Interface ──



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
        <HomeHeaderBar
          pulseKey={0}
          projectSlug="vax"
          callTool={styleguideMockCallTool}
          onProjectChange={() => {}}
          inboxState="ready"
          generatingCount={0}
          readyCount={4}
          onInboxClick={() => {}}
        />
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
              <div className="w-full"><VideoCard item={{ id: 'clip-s01', type: 'video', slug: '@s01', title: 'Purple Grind', filePath: '/styleguide-vid-purple-grind.jpg', status: 'ready', durationSeconds: 90, origin: 'wan21', thumbnailSrc: '/styleguide-vid-purple-grind.jpg' }} contextMenuContent={clipMenu('@s01', 'video')} /></div>
              <div className="w-full"><VideoCard item={{ id: 'clip-s02', type: 'video', slug: '@s02', title: 'Neon Fox', filePath: '/styleguide-img-neon-fox.jpg', status: 'ready', durationSeconds: 60, origin: 'veo3', thumbnailSrc: '/styleguide-img-neon-fox.jpg' }} contextMenuContent={clipMenu('@s02', 'video')} /></div>
              <div className="w-full"><VideoCard item={{ id: 'clip-s03', type: 'video', slug: '@s03', title: 'Sky Ghost', filePath: '/styleguide-vid-sky-ghost.jpg', status: 'ready', durationSeconds: 75, origin: 'veo3', thumbnailSrc: '/styleguide-vid-sky-ghost.jpg' }} contextMenuContent={clipMenu('@s03', 'video')} /></div>
              <div className="w-full"><FinalVideoCard item={{ id: 'demo-final-ready', type: 'final', slug: '@final-export-v2', title: 'Final Ready', filePath: '/final.mp4', status: 'ready', durationSeconds: 180, thumbnailSrc: '/styleguide-final-thumb.jpg' }} contextMenuContent={clipMenu('@final-export-v2', 'final')} /></div>
              <UploadSlot />
            </div>
          </CollapsibleSidebar>
        </div>

        {/* Timeline */}
        <div className="border-t border-border bg-card/30">
          <div className="relative h-28 flex gap-0.5">
            <TimelineSlot label="@s01" hasContent assetId="vid-purple-grind" waveform={DEMO_WAVEFORM} duration={12} flex={3} />
            <TimelineSlot label="@s02" hasContent assetId="vid-neon-fox" isActive waveform={DEMO_WAVEFORM} duration={8} flex={2} />
            <TimelineSlot label="@s03" hasContent assetId="vid-sky-ghost" waveform={DEMO_WAVEFORM} duration={5} flex={3} />
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
  const [prompt, setPrompt] = useState('Create a dynamic and engaging video showcasing a variety of scenes and scenarios, highlighting vibrant visuals and motion.');
  const [aspect, setAspect] = useState<string>('16:9');
  const [duration, setDuration] = useState<string>('8');
  const [mode, setMode] = useState<string>('std');
  const [sound, setSound] = useState<string>('Yes');
  const [selectedModel, setSelectedModel] = useState('kling3');
  const [imageSlugs, setImageSlugs] = useState<string[]>(['@img-neon-fox']);

  return (
    <div className="w-full h-full overflow-hidden rounded-lg border border-border/60 bg-background shadow-[0_0_40px_-12px_rgba(0,212,255,0.08)]">
      <div className="grid grid-rows-[48px_1fr_auto] h-full">
        <HomeHeaderBar
          pulseKey={0}
          projectSlug="vax"
          callTool={styleguideMockCallTool}
          onProjectChange={() => {}}
          inboxState="ready"
          generatingCount={0}
          readyCount={4}
          onInboxClick={() => {}}
        />
        <div className="flex flex-row overflow-hidden">
          <CollapsibleSidebar side="left" collapsed={false} onToggle={() => {}} expandedWidth="240px" collapsedWidth="40px" padding="px-2 pt-2 pb-2" gap="gap-0">
            <SidebarHeader icon={<Grid3x3 className="w-3.5 h-3.5" />} title="Assets" collapsed={false} onToggle={() => {}} side="left" sortOrder="newest" onSortChange={() => {}} />
            <div className="flex-1 overflow-y-auto space-y-2 pr-2">
              <div className="w-full"><ImageCard item={demoImageMock} contextMenuContent={clipMenu('@img-neon-fox', 'image')} /></div>
              <UploadSlot />
            </div>
          </CollapsibleSidebar>

          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 p-4 overflow-y-auto flex flex-col">
              <GenPanel
                label="VIDEO GEN"
                icon={<Zap className="w-4 h-4" />}
                onClose={() => {}}
                headerExtra={<CommandButton size="sm" command="/rewrite" icon={<Sparkles className="w-3 h-3" />} />}
                footer={
                  <div className="flex items-center justify-between">
                    <ModelSelector
                      selectedModelKey={selectedModel}
                      modelOptions={page2ModelOptions}
                      onChange={setSelectedModel}
                    />
                    <CommandButton command="/generate" icon={<Zap className="w-4 h-4" />} size="lg" />
                  </div>
                }
              >
                <div className="flex-1 overflow-y-auto pl-4 pr-6 py-4">
                  <div className="flex gap-4">
                    <div className="flex-1">
                      <div className="mb-3">
                        <GenField label="PROMPT" required>
                          <GenTextarea value={prompt} onChange={setPrompt} rows={5} />
                        </GenField>
                      </div>
                      <div className="flex flex-wrap gap-x-6 gap-y-4">
                        <GenField label="Aspect Ratio">
                          <GenToggle value={aspect} onChange={setAspect} options={['16:9', '9:16', '1:1']} />
                        </GenField>
                        <GenField label="Duration">
                          <GenToggle value={duration} onChange={setDuration} options={['5', '8', '10']} compact />
                        </GenField>
                        <GenField label="Mode">
                          <GenToggle value={mode} onChange={setMode} options={['std', 'pro']} />
                        </GenField>
                        <GenField label="Sound">
                          <GenToggle value={sound} onChange={setSound} options={['No', 'Yes']} />
                        </GenField>
                      </div>
                    </div>
                    <div className="w-44 shrink-0 border-l border-primary/20 bg-black/20 p-3">
                      <ImageParamSlots
                        assetFields={[{
                          name: 'image_slugs',
                          schema: { type: 'array', items: { type: 'string' } },
                          value: imageSlugs,
                          required: false,
                        }]}
                        resolvedAssets={page2ResolvedAssets}
                        imageSlots={{ min: 0, max: 2 }}
                        onChange={(_fieldName, value) => setImageSlugs(value as string[])}
                      />
                    </div>
                  </div>
                </div>
              </GenPanel>
            </div>
            <div className="shrink-0 px-4 pb-3 pt-2">
              <ChatInput assetSlugs={['@hero-intro', '@product-shot', '@bg-neon']} />
            </div>
          </div>

          <CollapsibleSidebar side="right" collapsed={false} onToggle={() => {}} expandedWidth="240px" collapsedWidth="40px" padding="px-2 pt-2 pb-2" gap="gap-0">
            <SidebarHeader icon={<Grid3x3 className="w-3.5 h-3.5" />} title="Clips" collapsed={false} onToggle={() => {}} side="right" sortOrder="newest" onSortChange={() => {}} />
            <div className="flex-1 overflow-y-auto space-y-2 mt-2 pr-2">
              <div className="w-full"><VideoCard item={demoVideoMock} contextMenuContent={clipMenu('@vid-purple-grind', 'video')} /></div>
            </div>
          </CollapsibleSidebar>
        </div>

        <div className="border-t border-border bg-card/30">
          <div className="relative h-28 flex gap-0.5">
            <TimelineSlot label="@s01" hasContent assetId="vid-purple-grind" waveform={DEMO_WAVEFORM} duration={12} flex={3} />
            <TimelineSlot label="@s02" hasContent assetId="vid-neon-fox" isActive waveform={DEMO_WAVEFORM} duration={8} flex={2} />
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

// ── Slide 4: Media Catalog ──

function Page4_MediaCatalog() {
  return (
    <div className="w-full h-full flex flex-col gap-6">
      <p className="text-xs font-mono text-zinc-400 leading-relaxed max-w-3xl">All 14 card states: receiving, plan, video, image, and final — every lifecycle phase at a glance.</p>
      <div className="flex-1 overflow-y-auto">
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

      {/* ChatInput bar */}
      <div className="shrink-0 border-t border-border/50 px-6 py-3">
        <ChatInput assetSlugs={['@hero-intro', '@product-shot', '@bg-neon', '@outro-final', '@clip-dance']} />
      </div>
    </div>
  );
}

// ── Slide 5: Design System ──

function Page5_DesignSystem() {
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

// ── Slide 6: Forms & Controls ──

function Page6_FormsControls() {
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

// ── Slide 7: Center Stage ──

function Page7_CenterStage() {
  return (
    <div className="w-full h-full grid grid-cols-3 gap-6">
      {/* IdleScreen */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">IdleScreen</p>
        <div className="flex-1 bg-black/60 rounded-xl overflow-hidden flex border border-cyan-500/20 shadow-[0_0_40px_-10px_rgba(0,212,255,0.15)] ring-1 ring-cyan-500/20 min-h-0">
          <IdleScreen label="WAITING_FOR_INPUT..." badge="SRC: NULL" />
        </div>
      </div>
      {/* AssetViewShell */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">AssetViewShell</p>
        <div className="flex-1 flex flex-col gap-4 min-h-0">
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
      {/* RenderingReadout */}
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

// ── Slide 3: Trimming ──

function Page3_Trimming() {
  return (
    <div className="w-full h-full flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-zinc-700/60 bg-gradient-to-r from-zinc-900 via-zinc-900/95 to-zinc-950 relative">
        <span className="font-mono text-xs tracking-widest text-zinc-400 uppercase">Trimming</span>
        <div className="absolute inset-x-0 flex justify-center pointer-events-none">
          <span className="font-mono text-xs tracking-widest text-zinc-400">@vid-purple-grind</span>
        </div>
        <CloseButton onClick={() => {}} />
      </div>

      {/* Video + Transcript */}
      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        <div className="flex-1 min-w-0 flex items-center justify-center bg-black">
          <video loop playsInline controls muted poster="/styleguide-img-cover.jpg" src="/fixtures/video-frost.mp4" className="w-full h-full object-contain" />
        </div>
        <div className="relative w-[320px] shrink-0 flex flex-col border-l border-cyan-500/30 bg-gradient-to-b from-zinc-950 to-zinc-900/90">
          <div className="shrink-0 px-4 py-2.5 border-b border-zinc-700/50 bg-zinc-900/80 flex items-center justify-between">
            <span className="text-[10px] font-mono tracking-[0.25em] uppercase text-cyan-500/70">Transcript</span>
            <span className="text-[10px] font-mono text-zinc-500">25 words &middot; 8.9s</span>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 leading-relaxed scrollbar-hide">
            <div className="leading-loose">
              {trimDemoWords.map((word, i) => {
                const isActive = i === trimActiveWordIndex;
                return (
                  <span key={i}>
                    <span className={cn('inline-block text-base font-sans cursor-pointer select-none px-0.5 mx-0.5 my-0.5 rounded-sm', isActive ? 'text-cyan-300 bg-cyan-500/15' : 'text-zinc-300')}>{word.text}</span>
                    {word.text.endsWith('.') && <br />}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar + Waveform */}
      <div className="shrink-0 px-6 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <CommandButton command="/select" icon={<Scissors className="w-4 h-4" />} size="default" variant="violet" />
          <CommandButton command="/clear" icon={<Eraser className="w-4 h-4" />} size="default" />
          <CommandButton command="/snap on" icon={<Magnet className="w-4 h-4" />} size="default" variant="violet" />
          <div className="flex-1" />
          <CommandButton command="/trim" icon={<Scissors className="w-4 h-4" />} size="default" />
        </div>

        <div className="relative overflow-visible" style={{ height: 96 }}>
          <div className="relative bg-black border border-zinc-700/50 rounded-md overflow-hidden select-none cursor-col-resize" style={{ height: 96 }}>
            <div className="absolute inset-0 rounded-md overflow-hidden">
              <StyleguideWaveform url="/fixtures/video-frost.mp4" height={96} waveColor="rgba(0, 255, 255, 0.15)" progressColor="rgba(0, 255, 255, 0.5)" progress={TRIM_PLAYHEAD_POS / 100} />
            </div>

            {/* Trim selection overlay */}
            <div
              className="absolute top-0 bottom-0 bg-violet-500/20 pointer-events-none z-10"
              style={{ left: `${trimDemoRange.startPct}%`, width: `${trimDemoRange.endPct - trimDemoRange.startPct}%` }}
            />
            {/* Start handle */}
            <div
              className="absolute top-0 bottom-0 z-20 flex items-stretch cursor-ew-resize"
              style={{ left: `${trimDemoRange.startPct}%`, transform: 'translateX(-50%)', width: 12 }}
            >
              <div className="w-0.5 bg-violet-400 mx-auto" />
            </div>
            {/* End handle */}
            <div
              className="absolute top-0 bottom-0 z-20 flex items-stretch cursor-ew-resize"
              style={{ left: `${trimDemoRange.endPct}%`, transform: 'translateX(-50%)', width: 12 }}
            >
              <div className="w-0.5 bg-violet-400 mx-auto" />
            </div>
            {/* Handle time labels */}
            <span
              className="absolute top-0.5 text-[9px] font-mono text-violet-300 pointer-events-none z-30 -translate-x-1/2"
              style={{ left: `${trimDemoRange.startPct}%` }}
            >
              {formatTrimTime((trimDemoRange.startPct / 100) * TRIM_DEMO_DURATION)}
            </span>
            <span
              className="absolute top-0.5 text-[9px] font-mono text-violet-300 pointer-events-none z-30 -translate-x-1/2"
              style={{ left: `${trimDemoRange.endPct}%` }}
            >
              {formatTrimTime((trimDemoRange.endPct / 100) * TRIM_DEMO_DURATION)}
            </span>
          </div>

          {/* Thumbnail badges — mini thumbnails with hover expansion */}
          {trimTimelineBadges.map((badge, i) => {
            const isStuckHover = i === 2;
            return (
              <div
                key={i}
                className={cn('absolute z-20', !isStuckHover && 'group')}
                style={{ left: `${badge.percent}%`, top: 0, bottom: 0 }}
              >
                {/* Full-height line */}
                <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-cyan-500/30" />
                {/* Micro thumbnail — centered */}
                <div
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-6 rounded-sm border border-cyan-400/60 bg-cover bg-center cursor-pointer shadow-[0_0_6px_rgba(34,211,238,0.3)]"
                  style={{ backgroundImage: `url(${badge.src})` }}
                />
                {/* Hover preview above waveform */}
                <div className={cn(
                  'absolute left-1/2 -translate-x-1/2 pointer-events-none transition-opacity z-50 flex flex-col items-center gap-1',
                  isStuckHover ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
                  style={{ bottom: 'calc(100% + 8px)' }}
                >
                  <div
                    className="w-[140px] h-[94px] rounded border border-cyan-400/60 bg-cover bg-center shadow-[0_0_12px_rgba(34,211,238,0.5)]"
                    style={{ backgroundImage: `url(${badge.src})` }}
                  />
                  <span className="text-[9px] font-mono text-cyan-400/80 whitespace-nowrap">{badge.time}</span>
                </div>
              </div>
            );
          })}

          {/* Playhead */}
          <div className="absolute top-0 pointer-events-none z-30" style={{ left: `${TRIM_PLAYHEAD_POS}%`, width: 3, height: 96, marginLeft: -1, backgroundColor: 'rgb(34, 211, 238)', filter: 'drop-shadow(0 0 6px rgba(34, 211, 238, 0.7))' }} />
        </div>

        {/* Time marks */}
        <div className="relative" style={{ height: 16 }}>
          {[0, 2, 4, 6, 8].map((sec) => (
            <span
              key={sec}
              className="absolute text-[10px] font-mono text-zinc-500 -translate-x-1/2"
              style={{ left: `${(sec / TRIM_DEMO_DURATION) * 100}%` }}
            >
              {formatTrimTime(sec)}
            </span>
          ))}
        </div>
      </div>

      {/* ChatInput bar */}
      <div className="shrink-0 border-t border-border/50 px-6 py-3">
        <ChatInput assetSlugs={['@hero-intro', '@product-shot', '@bg-neon', '@outro-final', '@clip-dance']} />
      </div>
    </div>
  );
}

// ── Slide 8: Back Face Panels ──

const mockManifestFiles: ManifestFile[] = [
  { name: '.original.json', size_bytes: 1228, extension: 'json' },
  { name: '.render-settings.json', size_bytes: 819, extension: 'json' },
  { name: 'original.mp4', size_bytes: 25_901_670, extension: 'mp4' },
  { name: 'landscape.mp4', size_bytes: 19_188_736, extension: 'mp4' },
  { name: 'portrait.mp4', size_bytes: 12_688_384, extension: 'mp4' },
  { name: 'thumbnail.jpg', size_bytes: 49_152, extension: 'jpg' },
];

const mockGitCommits: GitCommit[] = [
  { hash: 'a3f8c1d29e74b', message: 'generate: re-generate hero intro with updated prompt', date: '2026-03-23T09:42:00Z', files: ['original.mp4', '.original.json'] },
  { hash: 'b1e2d3c48f65a', message: 'restore: reverted to version c2d3e4f', date: '2026-03-22T15:30:00Z' },
  { hash: 'c2d3e4f57a86b', message: 'render: composite with background music track', date: '2026-03-22T11:00:00Z', files: ['landscape.mp4', 'portrait.mp4'] },
  { hash: 'd3e4f5a66b97c', message: 'generate: initial hero intro generation', date: '2026-03-21T14:20:00Z', files: ['original.mp4', '.original.json'] },
  { hash: 'e4f5a6b75c08d', message: 'upload: uploaded raw footage from camera', date: '2026-03-20T09:15:00Z', files: ['original.mp4'] },
  { hash: 'f5a6b7c84d19e', message: 'create: asset created', date: '2026-03-19T16:00:00Z', files: ['.original.json'] },
];

const mockFileContentJson = JSON.stringify({
  slug: 'vid-aurora-sky',
  created: '2026-03-18T14:32:00Z',
  source: 'upload',
  duration: 12.4,
  resolution: { width: 1920, height: 1080 },
  codec: 'h264',
  fps: 30,
}, null, 2);

const noop = () => {};

function BackFaceTabBar({ active }: { active: 'settings' | 'files' | 'history' }) {
  const tabs = ['settings', 'files', 'history'] as const;
  return (
    <div className="shrink-0 px-3 py-3 flex items-center justify-between relative bg-black/60 border-b border-zinc-800/60">
      <div className="flex gap-1">
        {tabs.map((tab) => (
          <span
            key={tab}
            className={cn(
              'h-8 px-3 flex items-center font-mono text-[13px] font-bold transition-all duration-[120ms] relative',
              tab === active ? 'text-cyan-400' : 'text-muted-foreground',
            )}
            style={{ background: tab === active ? 'rgba(0,217,255,0.06)' : 'transparent' }}
          >
            <span>/{tab}</span>
            {tab === active && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-cyan-400" />}
          </span>
        ))}
      </div>
      <span className="font-mono text-xs font-bold text-muted-foreground truncate">@vid-aurora-sky</span>
      <div className="w-6 h-6 flex items-center justify-center text-muted-foreground"><RotateCcw className="w-4 h-4 stroke-[2.5]" /></div>
    </div>
  );
}

function Page8_BackFacePanels() {
  return (
    <div className="w-full h-full flex gap-4">
      {/* /settings tab */}
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <p className="text-[12px] font-mono uppercase tracking-[0.12em] shrink-0" style={{ color: '#D8E7FF', opacity: 0.5 }}>Back Face — /settings tab</p>
        <div className="flex-1 flex flex-col overflow-hidden border border-zinc-600/50">
          <BackFaceTabBar active="settings" />
          <div className="flex-1 overflow-hidden">
            <RenderSettingsPanel
              orientations={[
                { orient: 'landscape', active: true },
                { orient: 'portrait', active: false },
                { orient: 'square', active: false },
              ]}
              subtitlesEnabled={true}
              subtitleStyle="impact"
              subtitlePosition="bottom"
              fontSize="medium"
              audioVolume={80}
              audioFadeIn={200}
              audioFadeOut={500}
              osgAssetId={null}
              osgAssetSrc={null}
              osgPosition="bottom-right"
              backgroundMode="blur"
              strokeWidth={6}
              strokeColor="#000000"
              shadowBlur={6}
              shadowOpacity={60}
            />
          </div>
        </div>
      </div>

      {/* /files tab */}
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <p className="text-[12px] font-mono uppercase tracking-[0.12em] shrink-0" style={{ color: '#D8E7FF', opacity: 0.5 }}>Back Face — /files tab</p>
        <div className="flex-1 flex flex-col overflow-hidden border border-zinc-600/50">
          <BackFaceTabBar active="files" />
          <div className="flex-1 flex min-h-0">
            <div className="w-[212px] shrink-0 border-r border-zinc-800/60 overflow-y-auto bg-black/40">
              <FileListPane
                files={mockManifestFiles}
                selectedFile=".original.json"
                onSelectFile={noop}
                onRefresh={noop}
                loading={false}
              />
            </div>
            <div className="flex-1 overflow-auto p-4 bg-black">
              <FileContentPane
                content={mockFileContentJson}
                loading={false}
                fileName=".original.json"
                fileUrl=""
              />
            </div>
          </div>
        </div>
      </div>

      {/* /history tab */}
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <p className="text-[12px] font-mono uppercase tracking-[0.12em] shrink-0" style={{ color: '#D8E7FF', opacity: 0.5 }}>Back Face — /history tab</p>
        <div className="flex-1 flex flex-col overflow-hidden border border-zinc-600/50">
          <BackFaceTabBar active="history" />
          <div className="flex-1 flex min-h-0">
            <div className="w-[220px] shrink-0 border-r border-zinc-800/60 overflow-y-auto bg-black/40 pr-1 pt-1">
              <HistoryListPane
                commits={mockGitCommits}
                selectedHash={mockGitCommits[0].hash}
                onSelectCommit={noop}
                onRefresh={noop}
                loading={false}
              />
            </div>
            <div className="flex-1 overflow-auto bg-black">
              <HistoryDetailPane
                commit={mockGitCommits[0]}
                isHead={true}
                onRestore={noop}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Slide 9: Workflow ──

function Page9_Workflow() {
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

// ── Slide 10: Command System ──

const mockProjects = [
  { slug: 'summer-campaign', active: false },
  { slug: 'prod', active: true },
  { slug: 'brand-refresh', active: false },
  { slug: 'q4-video-ads', active: false },
];

const mockCommands: CommandDescriptor[] = [
  { command: '/generate', description: 'Generate content from prompt', example: '/generate video of a dog on a skateboard @bg-neon', category: 'action', icon: 'Zap', size: 'lg', variant: 'default', chevron: 'right', params: [] },
  { command: '/rewrite', description: 'Optimize a prompt', example: '/rewrite "make it more cinematic"', category: 'action', icon: 'Sparkles', size: 'sm', variant: 'default', chevron: 'right', params: [] },
  { command: '/trim', description: 'Trim video clip', example: '/trim @hero-intro 0:05 0:12', category: 'action', icon: 'Scissors', size: 'lg', variant: 'default', chevron: 'right', params: [] },
  { command: '/vocals', description: 'Isolate vocals from audio', example: '/vocals @voiceover-main', category: 'action', icon: 'Mic', size: 'default', variant: 'violet', chevron: 'right', params: [] },
  { command: '/inbox', description: 'View generations inbox', example: '/inbox', category: 'action', icon: 'Mailbox', size: 'default', variant: 'default', chevron: 'down', params: [] },
];
const mockAssetSlugs = ['@hero-intro', '@product-shot', '@bg-neon', '@outro-clip', '@voiceover-main'];

function Page10_CommandSystem() {
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
                <CommandButton size="sm" command="/rewrite" icon={<Sparkles className="w-3 h-3" />} />
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
                <CommandButton command="/vocals" icon={<Mic className="w-3.5 h-3.5" />} variant="violet" />
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

function Page11_InboxReview() {
  const activeIndex = 2; // 3rd tile is active (0-based)
  return (
    <div className="w-full h-full flex flex-col bg-background">
      {/* InboxHeader */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
        <span className="text-xs font-mono font-bold tracking-widest text-primary/70 uppercase">REVIEW_QUEUE</span>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-cyan-400/80">{activeIndex + 1}/{reviewQueueItems.length}</span>
          <span className="text-xs font-mono text-amber-400/80">+{pendingQueueItems.length} pending</span>
          <button className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Unified grid — review cards + pending cards */}
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
                  <span className="absolute top-2 left-2 bg-black/70 text-primary text-xs font-mono font-bold px-1.5 py-0.5 rounded z-10">
                    {i + 1}
                  </span>
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
                    <X className="w-3.5 h-3.5" />/reject
                  </div>
                  <div className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-primary">
                    <Check className="w-3.5 h-3.5" />/accept
                  </div>
                </div>
              </div>
            );
          })}

          {/* Pending cards — full-sized in unified grid */}
          {pendingQueueItems.map((item) => {
            const w = item.width ?? 1920;
            const h = item.height ?? 1080;
            const isPortrait = h > w;
            const isSquare = w === h;
            const ratioLabel = isPortrait ? '9:16' : isSquare ? '1:1' : '16:9';
            const cardWidth = isPortrait ? 'w-[160px]' : isSquare ? 'w-[220px]' : 'w-[300px]';
            const statusTag = item.status === 'generating' ? 'GEN' : item.status === 'downloading' ? 'DL' : 'LOAD';
            return (
              <div
                key={item.id}
                className={cn(
                  cardWidth,
                  'rounded-lg overflow-hidden flex flex-col shrink-0',
                  'border border-amber-500/30 bg-card/60 animate-pulse'
                )}
              >
                <div className="bg-black relative" style={{ aspectRatio: `${w}/${h}` }}>
                  {item.thumbnailSrc ? (
                    <img src={item.thumbnailSrc} alt="" className="w-full h-full object-cover opacity-60" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="text-xs font-mono text-muted-foreground/30">{item.slug}</span>
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-5 h-5 animate-spin text-amber-500/80" />
                      <span className="text-[10px] font-mono font-bold bg-amber-500/15 text-amber-500/70 px-1.5 rounded">{statusTag}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-muted-foreground mt-auto">
                  <span className="text-amber-400/70 truncate">{item.slug}</span>
                  {item.prompt && (
                    <>
                      <span className="text-border">&middot;</span>
                      <span className="truncate text-muted-foreground/60">{item.prompt}</span>
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
              </div>
            );
          })}
        </div>
      </div>

      {/* ChatInput bar */}
      <div className="shrink-0 border-t border-border/50 px-6 py-3">
        <ChatInput placeholder="type /generate, /download..." />
      </div>
    </div>
  );
}

// ── Slide 12: Asset Viewer ──

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

function Page12_AssetViewer() {
  return (
    <MountKeyProvider>
    <div className="w-full h-full grid grid-cols-2 gap-6">
      {/* Left: Landscape viewer */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">ImageViewer — Landscape</p>
        <div className="flex-1 overflow-hidden flex min-h-0">
          <AssetViewer item={assetViewerMockImage} projectSlug="demo" size="landscape" onSizeChange={() => {}} flipped={false} onFlippedChange={() => {}} renderOrientation="landscape" settings={DEFAULT_RENDER_SETTINGS} onSettingsChange={() => {}} callTool={(() => Promise.resolve({ content: [], isError: false })) as never} />
        </div>
      </div>
      {/* Right: Portrait viewer */}
      <div className="flex flex-col gap-2 min-h-0">
        <p className="text-[11px] font-mono text-zinc-500 uppercase tracking-widest shrink-0">ImageViewer — Portrait</p>
        <div className="flex-1 overflow-hidden flex min-h-0">
          <AssetViewer item={assetViewerMockVideo} projectSlug="demo" size="portrait" onSizeChange={() => {}} flipped={false} onFlippedChange={() => {}} renderOrientation="landscape" settings={DEFAULT_RENDER_SETTINGS} onSettingsChange={() => {}} callTool={(() => Promise.resolve({ content: [], isError: false })) as never} />
        </div>
      </div>
    </div>
    </MountKeyProvider>
  );
}

// ── Slide 13: Timeline Player ──

const timelinePreviewByOrientation: Record<Orientation, TimelinePreviewData> = {
  landscape: {
    compositionWidth: 1920,
    compositionHeight: 1080,
    fps: 30,
    totalDurationInFrames: 201,
    slots: [{ src: '/landscape.mp4', durationInFrames: 201, volume: 100, fadeIn: 0, fadeOut: 0 }],
    slotOffsets: [0],
    ready: true,
  },
  portrait: {
    compositionWidth: 1080,
    compositionHeight: 1920,
    fps: 30,
    totalDurationInFrames: 300,
    slots: [{ src: '/portrait.mp4', durationInFrames: 300, volume: 100, fadeIn: 0, fadeOut: 0 }],
    slotOffsets: [0],
    ready: true,
  },
  square: {
    compositionWidth: 1080,
    compositionHeight: 1080,
    fps: 30,
    totalDurationInFrames: 1077,
    slots: [{ src: '/square.mp4', durationInFrames: 1077, volume: 100, fadeIn: 0, fadeOut: 0 }],
    slotOffsets: [0],
    ready: true,
  },
};

function TimelinePanel({ initialOrientation }: { initialOrientation: Orientation }) {
  const [orientation, setOrientation] = useState<Orientation>(initialOrientation);

  return (
    <div className="flex-1 min-h-0 bg-black/60 rounded-xl overflow-hidden border border-zinc-800/40 flex flex-col">
      <TimelinePlayer
        previewData={timelinePreviewByOrientation[orientation]}
        onOrientationChange={setOrientation}
      />
    </div>
  );
}

function Page13_TimelinePlayer() {
  return (
    <div className="w-full h-full grid grid-cols-2 grid-rows-2 gap-4">
      <TimelinePanel initialOrientation="landscape" />
      <TimelinePanel initialOrientation="portrait" />
      <TimelinePanel initialOrientation="square" />
      <TimelinePanel initialOrientation="landscape" />
    </div>
  );
}

// ── Slide Pages Array ──

const SLIDE_PAGES = [
  Page1_FinalVideoPreview,
  Page2_VideoGeneration,
  Page3_Trimming,
  Page4_MediaCatalog,
  Page5_DesignSystem,
  Page6_FormsControls,
  Page7_CenterStage,
  Page8_BackFacePanels,
  Page9_Workflow,
  Page10_CommandSystem,
  Page11_InboxReview,
  Page12_AssetViewer,
  Page13_TimelinePlayer,
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
