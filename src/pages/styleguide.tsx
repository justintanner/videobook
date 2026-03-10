import { useState } from 'react';
import { Link } from 'wouter';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { SelectWithChevron } from '@/components/ui/SelectWithChevron';
import { Toaster } from '@/components/ui/toaster';
import { toast } from '@/hooks/useToast';
import { Input } from '@/components/ui/input';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuCheckboxItem, ContextMenuLabel } from '@/components/ui/context-menu';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { SlugBadge, DurationBadge, ResolutionBadge } from '@/components/sidebar/cards/badges';
import { JsonSyntax } from '@/components/ui/JsonSyntax';
import { GenToggle } from '@/components/ui/GenToggle';
import { GenField, GenTextarea } from '@/components/ui/GenField';
import { GenSelect } from '@/components/ui/GenSelect';
import { MultiPromptEditor } from '@/components/ui/MultiPromptEditor';
import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import { ChatInput } from '@/components/ui/ChatInput';
import { AssetViewShell, IdleScreen, TransmissionView, RenderingReadout } from '@/components/center-stage';
import type { MediaItem } from '@/components/sidebar/types';
import {
  FolderOpen, X, ChevronDown, ChevronRight, ChevronLeft, Download, Upload, Sparkles,
  Film, Grid3x3, Scissors, Music, ClipboardList, MoreHorizontal, GripVertical,
  Zap, ArrowLeft, ImageIcon, Info, Settings, User, LogOut, Bell, Copy, Trash2,
  AlertTriangle, RotateCcw,
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

const variants = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const;
const sizes = ['default', 'sm', 'lg', 'xl', 'icon'] as const;

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
    <div className="bg-black/60 border border-primary/30 rounded px-3 py-1.5 text-xs font-mono font-bold tracking-wide text-primary/90 flex items-center gap-2">
      {text}
      <ChevronDown className="w-3 h-3 text-primary/50" />
    </div>
  );
}

function SceneSlot({ label }: { label: string }) {
  return (
    <div className="w-[200px] h-full shrink-0 border-r border-border/50 relative flex items-center justify-center">
      <span className="absolute top-1.5 left-1.5 text-xs font-mono text-primary bg-black/60 px-1.5 py-0.5 rounded">{label}</span>
      <button className="absolute top-1.5 right-1.5 text-xs text-muted-foreground">
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      <div className="w-3 h-3 bg-primary/60 rounded-full" />
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

function AppLayoutDemo() {
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  return (
    <div className="overflow-x-auto mb-8">
      <div className="min-w-[1100px] overflow-hidden rounded-lg border border-border bg-background">
        <div className="grid grid-rows-[48px_1fr_auto] h-[800px]">
          {/* ── Nav Bar ── */}
          <div className="bg-card border-b border-border flex items-center justify-between px-4">
            <div className="flex gap-4 items-center">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                <span className="font-mono font-bold text-sm text-foreground uppercase tracking-wider">CLIPFIRST</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <FolderOpen className="w-3.5 h-3.5" />
                <span className="font-mono text-sm">vax</span>
                <ChevronDown className="w-3 h-3" />
              </div>
              <div className="flex items-center gap-1.5">
                <Film className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">GENERATIONS</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Scissors className="w-3.5 h-3.5 text-primary" />
              <span className="font-mono text-xs uppercase tracking-wider text-primary">CLIP IT</span>
            </div>
          </div>

          {/* ── Middle Row: sidebars + center ── */}
          <div className="flex flex-row overflow-hidden">
            {/* Left Sidebar */}
            <div className={`${leftOpen ? 'w-[210px]' : 'w-[40px]'} transition-all duration-200 bg-card/50 border-r border-border flex flex-col overflow-hidden`}>
              <div className="px-3 pt-3 pb-2 flex items-center justify-between">
                {leftOpen ? (
                  <>
                    <div className="flex items-center gap-1.5">
                      <Grid3x3 className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">ASSETS</span>
                    </div>
                    <div className="flex gap-1">
                      <button className="text-muted-foreground/50 hover:text-muted-foreground"><Download className="w-3.5 h-3.5" /></button>
                      <button className="text-muted-foreground/50 hover:text-muted-foreground"><ClipboardList className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setLeftOpen(false)} className="text-muted-foreground/50 hover:text-muted-foreground"><ChevronLeft className="w-3.5 h-3.5" /></button>
                    </div>
                  </>
                ) : (
                  <button onClick={() => setLeftOpen(true)} className="text-muted-foreground/50 hover:text-muted-foreground mx-auto">
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {leftOpen && (
                <>
                  <div className="flex-1 overflow-y-auto px-2 space-y-2">
                    <div className="w-full"><ImageCard item={demoImageMock} /></div>
                  </div>
                  <div className="p-2 mt-auto">
                    <Button variant="dashed" className="w-full" size="sm">
                      <Upload className="w-3.5 h-3.5" />
                      UPLOAD_ASSET
                    </Button>
                  </div>
                </>
              )}
            </div>

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
              <div className="shrink-0 px-4 pb-3 pt-2 border-t border-primary/20 bg-black/40">
                <div className="border border-primary/40 rounded-md px-3 py-2.5 flex items-center justify-between bg-black/60 shadow-[inset_0_0_12px_rgba(0,255,255,0.08)]">
                  <div className="flex items-center gap-2">
                    <ChevronRight className="w-3.5 h-3.5 text-primary/60" />
                    <span className="text-sm font-mono text-primary/70">gen image of a dancing banana</span>
                  </div>
                  <GripVertical className="w-3.5 h-3.5 text-primary/30" />
                </div>
              </div>
            </div>

            {/* Right Sidebar */}
            <div className={`${rightOpen ? 'w-[210px]' : 'w-[40px]'} transition-all duration-200 bg-card/50 border-l border-border flex flex-col overflow-hidden`}>
              <div className="px-3 pt-3 pb-2 flex items-center justify-between">
                {rightOpen ? (
                  <>
                    <div className="flex gap-1">
                      <button onClick={() => setRightOpen(false)} className="text-muted-foreground/50 hover:text-muted-foreground"><ChevronRight className="w-3.5 h-3.5" /></button>
                      <button className="text-muted-foreground/50 hover:text-muted-foreground"><Download className="w-3.5 h-3.5" /></button>
                      <button className="text-muted-foreground/50 hover:text-muted-foreground"><ClipboardList className="w-3.5 h-3.5" /></button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Grid3x3 className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">CLIPS</span>
                    </div>
                  </>
                ) : (
                  <button onClick={() => setRightOpen(true)} className="text-muted-foreground/50 hover:text-muted-foreground mx-auto">
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {rightOpen && (
                <>
                  <div className="flex-1 overflow-y-auto px-2 mt-2 space-y-2">
                    <div className="w-full"><VideoCard item={demoVideoMock} /></div>
                  </div>
                  <div className="p-2 mt-auto">
                    <Button variant="dashed" className="w-full" size="sm">
                      <Upload className="w-3.5 h-3.5" />
                      UPLOAD_CLIP
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── Bottom Timeline ── */}
          <div className="h-[120px] border-t border-border bg-card/30">
            <div className="flex overflow-x-auto h-[90px]">
              {['@s01', '@s02', '@s03', '@s04', '@s05'].map((label) => (
                <SceneSlot key={label} label={label} />
              ))}
            </div>
            <div className="h-[30px] flex items-center justify-center border-t border-border/30 gap-2">
              <Music className="w-3.5 h-3.5 text-muted-foreground/50" />
              <span className="text-xs font-mono text-muted-foreground/50 uppercase tracking-wider">DROP_AUDIO_TRACK</span>
            </div>
          </div>
        </div>
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
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Standard</p>
        <GenToggle value={aspect} onChange={setAspect} options={['16:9', '9:16', '1:1']} />
      </div>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Two options</p>
        <GenToggle value={mode} onChange={setMode} options={['std', 'pro']} />
      </div>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Compact</p>
        <GenToggle value={compactVal} onChange={setCompactVal} options={['3', '5', '8', '10']} compact />
      </div>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Disabled</p>
        <GenToggle value="std" onChange={() => {}} options={['std', 'pro']} disabled />
      </div>
    </div>
  );
}

function GenFieldDemo() {
  const [text, setText] = useState('A cinematic shot of a neon-lit cityscape at night');
  return (
    <div className="space-y-4 max-w-md">
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
    <div className="max-w-md">
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
    <div className="flex gap-4">
      <div className="w-[180px] space-y-1">
        <p className="text-xs text-muted-foreground">With value (image)</p>
        <AssetDropSlot value={filled} onChange={setFilled} />
      </div>
      <div className="w-[180px] space-y-1">
        <p className="text-xs text-muted-foreground">Empty (image)</p>
        <AssetDropSlot value={empty} onChange={setEmpty} />
      </div>
      <div className="w-[180px] space-y-1">
        <p className="text-xs text-muted-foreground">Empty (video)</p>
        <AssetDropSlot value={null} onChange={() => {}} acceptTypes={['video']} />
      </div>
      <div className="w-[180px] space-y-1">
        <p className="text-xs text-muted-foreground">Disabled</p>
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
        <div className="w-[300px] h-[120px] rounded-lg border-2 border-dashed border-primary/30 bg-card flex items-center justify-center cursor-context-menu select-none">
          <span className="text-sm font-mono text-muted-foreground">Right-click here</span>
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

// ── CenterStage: TransmissionView ──

const centerStageMocks = [
  { id: 'cs-transmission', label: 'transmission', message: 'Generate a 30s product demo with upbeat music' },
  { id: 'cs-transmission-short', label: 'transmission (short)', message: 'Retry render' },
];

function CenterStageSection() {
  return (
    <section className="mb-12">
      <h2 className="text-xl font-mono font-bold mb-2 text-blue-400">CenterStage: TransmissionView</h2>
      <p className="text-xs font-mono text-muted-foreground mb-6">
        Animated transition shown when a new message is sent. Phases: flash scan line, typewriter text, dissolve.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {centerStageMocks.map((mock) => (
          <div key={mock.id} className="flex flex-col gap-2">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{mock.label}</span>
            <div className="h-[300px] bg-background border border-border/50 rounded overflow-hidden">
              <TransmissionView message={mock.message} onComplete={() => {}} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── CenterStage: IdleScreen ──

const idleScreenMocks = [
  { id: 'idle-welcome', label: 'welcome', props: { label: 'WAITING_FOR_INPUT...', badge: 'SRC: NULL' } },
  { id: 'idle-empty-timeline', label: 'timeline-empty', props: { label: 'NO_VIDEO_CONTENT...', fillParent: true as const } },
  { id: 'idle-no-badge', label: 'idle (no badge)', props: { label: 'STANDBY...' } },
];

function IdleScreenSection() {
  return (
    <section className="mb-12">
      <h2 className="text-xl font-mono font-bold mb-2 text-blue-400">CenterStage: IdleScreen</h2>
      <p className="text-xs font-mono text-muted-foreground mb-6">
        Pulsing idle states shown when no asset is selected or the timeline is empty. Badge appears in welcome mode only.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {idleScreenMocks.map((mock) => (
          <div key={mock.id} className="flex flex-col gap-2">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{mock.label}</span>
            <div className="h-[250px] bg-background border border-border/50 rounded overflow-hidden flex">
              <IdleScreen {...mock.props} />
            </div>
          </div>
        ))}
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
    <section className="mb-12">
      <h2 className="text-xl font-mono font-bold mb-2 text-blue-400">CenterStage: AssetViewShell</h2>
      <p className="text-xs font-mono text-muted-foreground mb-6">
        Shared frame for all asset-mode views. Two modes: constrained (max-w-4xl, aspect-video) and full bleed (w-full
        h-full). Border + shadow provide consistent visual containment.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {assetViewShellMocks.map((mock) => (
          <div key={mock.id} className="flex flex-col gap-2">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{mock.label}</span>
            <div className="h-[250px] bg-background border border-border/50 rounded overflow-hidden flex">
              <AssetViewShell fillParent={mock.fillParent}>
                <div className="flex items-center justify-center w-full h-full">
                  <span className="font-mono text-xs text-primary/40">CONTENT_AREA</span>
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
    <section className="mb-12">
      <h2 className="text-xl font-mono font-bold mb-2 text-blue-400">RenderingReadout (Center-Stage View)</h2>
      <p className="text-xs font-mono text-muted-foreground mb-6">
        Full-panel rendering status view shown in center stage when a video asset is rendering. Scan line animation,
        grid overlay, corner HUD brackets, Film/Clapperboard icon (type-aware), pulsing status badge, and slug text.
        Cyan for regular videos, amber for final-type assets.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        {renderingReadoutMocks.map((mock) => (
          <div key={mock.id} className="flex flex-col gap-2">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{mock.label}</span>
            <div className="w-[250px] h-[200px] border border-border/50 rounded overflow-hidden">
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
    <section className="mb-12">
      <h2 className="text-xl font-mono font-bold mb-2 text-blue-400">FailedAssetReadout (Center-Stage View)</h2>
      <p className="text-xs font-mono text-muted-foreground mb-6">
        Error diagnostic panel shown in center stage for failed assets. Displays error message, prompt used, model/tool
        info, and optional retry button. Static replica below — the real component fetches diagnostic data via
        useAssetDiagnostic hook which requires a live API connection.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* With error + prompt + model + retry */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            full diagnostic (with retry)
          </span>
          <div className="w-[350px] h-[280px] overflow-hidden">
            <div className="w-full h-full bg-black/95 font-mono text-xs flex flex-col border border-red-500/30">
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
              <div className="shrink-0 p-3 border-t border-red-500/30 bg-red-950/20">
                <button className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-primary/10 border border-primary/30 rounded text-primary font-bold tracking-wider">
                  <RotateCcw className="w-4 h-4" />
                  RETRY
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Minimal error — no prompt, no retry */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">minimal (error only)</span>
          <div className="w-[350px] h-[200px] overflow-hidden">
            <div className="w-full h-full bg-black/95 font-mono text-xs flex flex-col border border-red-500/30">
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

// ── Main Styleguide ──

export function Styleguide() {
  return (
    <div className="min-h-screen p-8 space-y-12">
      <Toaster />
      <header className="space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold font-mono tracking-wider text-blue-400">CLIPFIRST STYLE GUIDE</h1>
          <Link href="/" className="text-sm font-mono text-muted-foreground hover:text-primary transition-colors flex items-center gap-1.5">
            <ArrowLeft className="w-3.5 h-3.5" />
            Dashboard
          </Link>
        </div>
        <p className="text-sm font-mono text-muted-foreground">Media cards, overlays, and center-stage views in all states</p>
      </header>

      {/* App Layout Demo */}
      <AppLayoutDemo />

      <hr className="border-border" />
      <h2 className="text-2xl font-bold text-blue-400 font-mono">Component Catalog</h2>

      {/* Colors + Typography + Buttons — compact row */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Colors */}
        <div className="space-y-3">
          <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Colors</h2>
          <div className="grid grid-cols-4 gap-2">
            {colors.map((c) => (
              <div key={c.name} className="space-y-1">
                <div className={`${c.bg} rounded h-10 border border-border`} />
                <p className="text-[10px] font-medium leading-tight">{c.name}</p>
                <p className="text-[9px] font-mono text-muted-foreground leading-tight">{c.hex}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Typography */}
        <div className="space-y-3">
          <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Typography</h2>
          <div className="space-y-1">
            <p className="text-xl font-bold">Rajdhani Bold</p>
            <p className="text-lg font-semibold">Rajdhani Semibold</p>
            <p className="text-base font-normal">Rajdhani Regular</p>
            <p className="text-base font-light">Rajdhani Light</p>
            <p className="font-mono text-sm">JetBrains Mono — 0123456789</p>
            <p className="font-mono text-xs text-muted-foreground">const x = await fetchData();</p>
          </div>
        </div>

        {/* Buttons */}
        <div className="space-y-3">
          <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Buttons</h2>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {variants.map((v) => (
                <Button key={v} variant={v} size="sm">{v}</Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {sizes.map((s) => (
                <Button key={s} size={s}>{s === 'icon' ? '?' : s}</Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled>Disabled</Button>
              <Button size="sm" variant="destructive" disabled>Disabled</Button>
            </div>
          </div>
        </div>
      </section>

      {/* ==================== MEDIA CARD SECTIONS ==================== */}

      {/* Cards — unique overlays */}
      <section className="space-y-4">
        <h2 className="text-xl font-mono font-bold border-b border-border pb-2 text-blue-400">Cards</h2>
        <div className="flex flex-wrap gap-3">
          <div className="w-[200px]"><ReceivingGhostCard filename="hero-intro-final.mp4" /></div>
          <div className="w-[200px]"><PlanCard item={{ id: 'plan-ready-empty', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready' }} /></div>
          <div className="w-[200px]"><PlanCard item={{ id: 'plan-ready-text', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready', prompt: 'Scene 1: Wide establishing shot of the city skyline at golden hour. Camera slowly pans right to reveal the protagonist standing on a rooftop.\n\nScene 2: Close-up of hands typing on a laptop. Cut to screen showing data visualization.\n\nScene 3: Interview segment with soft key light.' }} /></div>
          {cardOverlayMocks.map(({ item, Component }) => (
            <div key={item.id} className="w-[200px]"><Component item={item} /></div>
          ))}
        </div>
      </section>

      {/* ==================== NEW UI PRIMITIVES ==================== */}

      {/* Dialog */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Dialog</h2>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">Open Dialog</Button>
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
      </section>

      {/* Dropdown Menu */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Dropdown Menu</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Settings className="w-3.5 h-3.5 mr-1.5" />
              Options
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
      </section>

      {/* Popover + Tooltip row */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Popover & Tooltip</h2>
        <div className="flex gap-4 items-center">
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
                <Button variant="outline" size="sm">Hover for Tooltip</Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Neural interface ready</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </section>

      {/* Scroll Area */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Scroll Area</h2>
        <ScrollArea className="h-[120px] w-[300px] rounded border border-border bg-card p-3">
          <div className="space-y-2">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="text-xs font-mono text-muted-foreground">
                [{String(i + 1).padStart(2, '0')}] subsystem_node_{i + 1} &mdash; ONLINE
              </div>
            ))}
          </div>
        </ScrollArea>
      </section>

      {/* Toast */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Toast</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => toast({ title: 'TRANSMISSION RECEIVED', description: 'Asset uploaded successfully.' })}
          >
            Default Toast
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => toast({ title: 'SYSTEM ERROR', description: 'Neural link interrupted.', variant: 'destructive' })}
          >
            Destructive Toast
          </Button>
        </div>
      </section>

      {/* SelectWithChevron */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">SelectWithChevron</h2>
        <div className="w-[240px]">
          <SelectWithChevronDemo />
        </div>
      </section>

      {/* ==================== BATCH 2: NEW COMPONENTS ==================== */}

      {/* Input */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Input</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Default</p>
            <Input placeholder="Enter text..." />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Email</p>
            <Input type="email" placeholder="user@example.com" />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Disabled</p>
            <Input placeholder="Disabled" disabled />
          </div>
        </div>
      </section>

      {/* Context Menu */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Context Menu</h2>
        <ContextMenuDemo />
      </section>

      {/* Card Primitives */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Card Primitives</h2>
        <div className="flex flex-wrap gap-4">
          <Card className="w-[300px]">
            <CardHeader>
              <CardTitle>System Status</CardTitle>
              <CardDescription>All subsystems operational</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Neural link integrity at 98.7%. Memory usage nominal. Renderer: WebGPU v2.1.</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">Details</Button>
              <Button size="sm" variant="outline">Dismiss</Button>
            </CardFooter>
          </Card>
          <Card className="w-[300px]">
            <CardHeader>
              <CardTitle>Render Queue</CardTitle>
              <CardDescription>3 jobs pending</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 text-xs font-mono text-muted-foreground">
                <p>[01] hero-intro — encoding</p>
                <p>[02] product-shot — queued</p>
                <p>[03] outro — queued</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Badges */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Badges</h2>
        <div className="flex flex-wrap gap-4">
          <div className="relative w-[180px] h-[100px] bg-card border border-border rounded overflow-hidden">
            <SlugBadge slug="@hero-intro" colorScheme="cyan" isError={false} />
          </div>
          <div className="relative w-[180px] h-[100px] bg-card border border-border rounded overflow-hidden">
            <SlugBadge slug="@final-export" colorScheme="gold" isError={false} />
          </div>
          <div className="relative w-[180px] h-[100px] bg-card border border-border rounded overflow-hidden">
            <SlugBadge slug="@broken-clip" colorScheme="cyan" isError={true} />
          </div>
          <div className="relative w-[180px] h-[100px] bg-card border border-border rounded overflow-hidden">
            <SlugBadge slug="@processing" colorScheme="cyan" isError={false} isProcessing />
          </div>
          <div className="relative w-[180px] h-[100px] bg-card border border-border rounded overflow-hidden">
            <DurationBadge duration="1:30" isProcessing={false} />
          </div>
          <div className="relative w-[180px] h-[100px] bg-card border border-border rounded overflow-hidden">
            <DurationBadge duration="0:45" isProcessing={true} />
          </div>
          <div className="relative w-[180px] h-[100px] bg-card border border-border rounded overflow-hidden">
            <ResolutionBadge width={1920} height={1080} />
          </div>
          <div className="relative w-[180px] h-[100px] bg-card border border-border rounded overflow-hidden">
            <ResolutionBadge width={3840} height={2160} />
          </div>
        </div>
      </section>

      {/* JsonSyntax */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">JsonSyntax</h2>
        <div className="max-w-lg bg-card border border-border rounded-lg p-4">
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

      {/* GenToggle */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">GenToggle</h2>
        <GenToggleDemo />
      </section>

      {/* GenField + GenTextarea */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">GenField + GenTextarea</h2>
        <GenFieldDemo />
      </section>

      {/* GenSelect */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">GenSelect</h2>
        <GenSelectDemo />
      </section>

      {/* MultiPromptEditor */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">MultiPromptEditor</h2>
        <MultiPromptEditorDemo />
      </section>

      {/* AssetDropSlot */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">AssetDropSlot</h2>
        <AssetDropSlotDemo />
      </section>

      {/* ChatInput */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">ChatInput</h2>
        <div className="max-w-lg space-y-3">
          <p className="text-xs text-muted-foreground">Type @ to trigger autocomplete with sample asset slugs</p>
          <ChatInput assetSlugs={['@hero-intro', '@product-shot', '@bg-neon', '@outro-final', '@clip-dance']} />
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

      {/* Custom Utilities */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-blue-400">Custom Utilities</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="bg-card border border-border p-3 clip-corner-tl">
            <p className="text-xs font-medium">.clip-corner-tl</p>
          </div>
          <div className="bg-card border border-border p-3 clip-corner-br">
            <p className="text-xs font-medium">.clip-corner-br</p>
          </div>
          <div className="bg-card border border-border p-3 clip-corner-both">
            <p className="text-xs font-medium">.clip-corner-both</p>
          </div>
          <div className="bg-card border border-primary p-3 border-glow rounded-lg">
            <p className="text-xs font-medium">.border-glow</p>
          </div>
        </div>
        <div className="bg-card border border-border p-3 rounded-lg relative overflow-hidden">
          <div className="absolute inset-0 scanlines pointer-events-none" />
          <p className="text-xs font-medium relative">.scanlines</p>
        </div>
      </section>

    </div>
  );
}
