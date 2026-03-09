import { useState } from 'react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { VideoCard } from '@/components/sidebar/cards/VideoCard';
import { FinalVideoCard } from '@/components/sidebar/cards/FinalVideoCard';
import { ImageCard } from '@/components/sidebar/cards/ImageCard';
import { PlanCard } from '@/components/sidebar/cards/PlanCard';
import { ReceivingGhostCard } from '@/components/sidebar/cards/ReceivingGhostCard';
import type { MediaItem } from '@/components/sidebar/types';
import {
  FolderOpen, X, ChevronDown, ChevronRight, ChevronLeft, Download, Upload, Sparkles,
  Film, Grid3x3, Scissors, Music, ClipboardList, MoreHorizontal, GripVertical,
  Zap,
} from 'lucide-react';

const colors = [
  { name: 'Primary', bg: 'bg-primary', hex: '#00D4FF' },
  { name: 'Secondary', bg: 'bg-secondary', hex: '#1D3135' },
  { name: 'Accent', bg: 'bg-accent', hex: '#FF9500' },
  { name: 'Destructive', bg: 'bg-destructive', hex: '#EB4747' },
  { name: 'Muted', bg: 'bg-muted', hex: '#19252A' },
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

function BracketLabel({ label }: { label: string }) {
  return <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">[{label}]</span>;
}

function ToggleGroup({ options, activeIndex }: { options: string[]; activeIndex: number }) {
  return (
    <div className="flex">
      {options.map((opt, i) => {
        const isFirst = i === 0;
        const isLast = i === options.length - 1;
        const rounded = isFirst && isLast ? '' : isFirst ? 'rounded-r-none' : isLast ? 'rounded-l-none' : 'rounded-none border-x-0';
        return (
          <Button
            key={opt}
            variant={i === activeIndex ? 'toggleActive' : 'toggleInactive'}
            size="sm"
            className={rounded}
          >
            {opt}
          </Button>
        );
      })}
    </div>
  );
}

function FakeDropdown({ text }: { text: string }) {
  return (
    <div className="bg-muted border border-input rounded-md px-3 py-1.5 text-sm font-mono flex items-center gap-2">
      {text}
      <ChevronDown className="w-3 h-3 text-muted-foreground" />
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
            <div className="flex-1 p-4 overflow-y-auto">
              {/* VIDEO_GENERATION Panel */}
              <div className="border border-primary/50 rounded-md p-3">
                {/* Title row */}
                <div className="flex justify-between items-center mb-3">
                  <div className="flex items-center gap-2">
                    <Grid3x3 className="w-3.5 h-3.5 text-primary" />
                    <span className="font-mono text-sm font-bold text-primary uppercase tracking-wider">VIDEO_GENERATION</span>
                  </div>
                  <Button variant="ghost" size="icon" className="h-7 w-7">
                    <X className="w-4 h-4" />
                  </Button>
                </div>

                {/* Two-column layout: left = form, right = images */}
                <div className="flex flex-row">
                  {/* Left column */}
                  <div className="flex-1 min-w-0">
                    {/* [PROMPT] section */}
                    <div className="space-y-2 mb-3">
                      <div className="flex items-center justify-between">
                        <BracketLabel label="PROMPT" />
                        <Button variant="default" size="sm">
                          <Sparkles className="w-3.5 h-3.5" />
                          Rewrite
                        </Button>
                      </div>
                      <textarea
                        className="bg-muted/30 border border-input/50 rounded-md p-3 text-sm font-mono text-foreground/80 resize-none h-28 w-full focus:outline-none focus:ring-1 focus:ring-ring"
                        defaultValue="Create a dynamic and engaging video showcasing a variety of scenes and scenarios, highlighting vibrant visuals and motion."
                        readOnly
                      />
                    </div>

                    {/* + SCENE button */}
                    <Button variant="dashed" className="w-full mb-3">+ SCENE</Button>

                    {/* Parameters row */}
                    <div className="flex flex-wrap gap-x-8 gap-y-3 my-3">
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

                    {/* + ADD ELEMENT button */}
                    <Button variant="dashed" className="w-full">+ ADD ELEMENT</Button>

                    {/* WARNINGS box */}
                    <div className="mt-3 bg-amber-500/10 border border-amber-500/30 rounded-md p-3">
                      <div className="text-xs font-mono font-bold text-amber-400 uppercase tracking-wider mb-1">WARNINGS</div>
                      <ul className="list-disc list-inside">
                        <li className="text-xs font-mono text-amber-400/80">Kling 3.0 multi_prompt must be a non-empty list</li>
                      </ul>
                    </div>

                    {/* Footer row */}
                    <div className="flex justify-between items-center mt-3">
                      <FakeDropdown text="Kling 3.0" />
                      <Button variant="glow" size="lg">
                        <Zap className="w-4 h-4" />
                        GENERATE
                      </Button>
                    </div>
                  </div>

                  {/* Right column — IMAGES */}
                  <div className="w-[160px] shrink-0 border-l border-border/50 pl-3 ml-3">
                    <div className="flex items-center justify-between mb-2">
                      <BracketLabel label="IMAGES" />
                      <span className="text-xs font-mono text-muted-foreground">1/2</span>
                    </div>
                    <div className="space-y-2">
                      <div className="w-[80px] h-[60px] border border-border/50 rounded overflow-hidden">
                        <img src="/styleguide-img-cover.jpg" alt="thumbnail" className="w-full h-full object-cover" />
                      </div>
                      <div className="w-[80px] h-[60px] border border-dashed border-border/50 rounded" />
                    </div>
                  </div>
                </div>
              </div>

            </div>
              {/* Chat input — sticky bottom */}
              <div className="shrink-0 px-4 pb-3 pt-2 border-t border-border/30">
                <div className="border border-border/50 rounded-md px-3 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm font-mono text-muted-foreground">gen image of a dancing banana</span>
                  </div>
                  <GripVertical className="w-3.5 h-3.5 text-muted-foreground/50" />
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

// ── Main Styleguide ──

export function Styleguide() {
  return (
    <div className="min-h-screen p-8 space-y-12">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-primary">Styleguide</h1>
        <Link href="/" className="text-sm text-muted-foreground hover:text-primary transition-colors">
          &larr; Dashboard
        </Link>
      </header>

      {/* App Layout Demo */}
      <AppLayoutDemo />

      <hr className="border-border" />
      <h2 className="text-2xl font-bold text-primary font-mono">Component Catalog</h2>

      {/* Colors + Typography + Buttons — compact row */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Colors */}
        <div className="space-y-3">
          <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-primary">Colors</h2>
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
          <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-primary">Typography</h2>
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
          <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-primary">Buttons</h2>
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
        <h2 className="text-xl font-mono font-bold border-b border-border pb-2 text-primary">Cards</h2>
        <div className="flex flex-wrap gap-3">
          <div className="w-[200px]"><ReceivingGhostCard filename="hero-intro-final.mp4" /></div>
          <div className="w-[200px]"><PlanCard item={{ id: 'plan-ready-empty', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready' }} /></div>
          <div className="w-[200px]"><PlanCard item={{ id: 'plan-ready-text', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready', prompt: 'Scene 1: Wide establishing shot of the city skyline at golden hour. Camera slowly pans right to reveal the protagonist standing on a rooftop.\n\nScene 2: Close-up of hands typing on a laptop. Cut to screen showing data visualization.\n\nScene 3: Interview segment with soft key light.' }} /></div>
          {cardOverlayMocks.map(({ item, Component }) => (
            <div key={item.id} className="w-[200px]"><Component item={item} /></div>
          ))}
        </div>
      </section>

      {/* Custom Utilities */}
      <section className="space-y-3">
        <h2 className="text-lg font-mono font-bold border-b border-border pb-2 text-primary">Custom Utilities</h2>
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
