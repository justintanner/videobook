import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { VideoCard } from '@/components/sidebar/cards/VideoCard';
import { FinalVideoCard } from '@/components/sidebar/cards/FinalVideoCard';
import { ImageCard } from '@/components/sidebar/cards/ImageCard';
import { ScriptCard } from '@/components/sidebar/cards/ScriptCard';
import { AudioCard } from '@/components/sidebar/cards/AudioCard';
import { PlanCard } from '@/components/sidebar/cards/PlanCard';
import { ReceivingGhostCard } from '@/components/sidebar/cards/ReceivingGhostCard';
import { SlugBadge, DurationBadge, ResolutionBadge } from '@/components/sidebar/cards/badges';
import type { MediaItem } from '@/components/sidebar/types';

const colors = [
  { name: 'Primary', bg: 'bg-primary', fg: 'text-primary-foreground' },
  { name: 'Secondary', bg: 'bg-secondary', fg: 'text-secondary-foreground' },
  { name: 'Accent', bg: 'bg-accent', fg: 'text-accent-foreground' },
  { name: 'Destructive', bg: 'bg-destructive', fg: 'text-destructive-foreground' },
  { name: 'Muted', bg: 'bg-muted', fg: 'text-muted-foreground' },
  { name: 'Card', bg: 'bg-card', fg: 'text-card-foreground' },
  { name: 'Background', bg: 'bg-background', fg: 'text-foreground' },
  { name: 'Popover', bg: 'bg-popover', fg: 'text-popover-foreground' },
] as const;

const variants = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const;
const sizes = ['default', 'sm', 'lg', 'icon'] as const;

// ── Mock Data ──

const videoMocks: MediaItem[] = [
  { id: 'video-uploading', type: 'video', slug: '@hero-intro', title: 'Hero Intro', filePath: '', status: 'uploading', durationSeconds: 30, origin: 'veo3', thumbnailSrc: null },
  { id: 'video-loading', type: 'video', slug: '@processing-clip', title: 'Processing Clip', filePath: '/sample.mp4', status: 'loading', durationSeconds: 60, origin: 'veo3', thumbnailSrc: '/opengraph.jpg' },
  { id: 'video-untranscribed', type: 'video', slug: '@customer-interview-segment', title: 'Interview', filePath: '/sample.mp4', status: 'untranscribed', durationSeconds: 120, origin: 'veo3', thumbnailSrc: '/opengraph.jpg' },
  { id: 'video-transcribing', type: 'video', slug: '@customer-interview-segment-final', title: 'Interview', filePath: '/sample.mp4', status: 'transcribing', durationSeconds: 120, origin: 'veo3', thumbnailSrc: '/opengraph.jpg' },
  { id: 'video-rendering', type: 'video', slug: '@final-cut-rendering', title: 'Final Cut', filePath: '', status: 'rendering', durationSeconds: 120, origin: 'veo3', thumbnailSrc: '/opengraph.jpg' },
  { id: 'video-ready', type: 'video', slug: '@main', title: 'Main Feature', filePath: '/sample.mp4', status: 'ready', durationSeconds: 90, origin: 'wan21', thumbnailSrc: '/opengraph.jpg' },
  { id: 'video-error', type: 'video', slug: '@broken-clip-needs-rerender', title: 'Broken Clip', filePath: '', status: 'error', durationSeconds: 30, origin: 'veo3', thumbnailSrc: null },
  { id: 'video-corrupt', type: 'video', slug: '@glitched-footage', title: 'Glitched Footage', filePath: '', status: 'corrupt', durationSeconds: 45, origin: 'veo3', thumbnailSrc: null },
];

const videoStateLabels: Record<string, string> = {
  untranscribed: 'pending*',
  rendering: 'rendering*',
};

const finalMocks: MediaItem[] = [
  { id: 'vid-final-loading', type: 'final', slug: '@final-processing', title: 'Final', filePath: '/final.mp4', status: 'loading', durationSeconds: 180, thumbnailSrc: null },
  { id: 'vid-final-rendering', type: 'final', slug: '@final', title: 'Final', filePath: '', status: 'rendering', durationSeconds: 180, thumbnailSrc: null },
  { id: 'vid-final-ready', type: 'final', slug: '@final-export-v2', title: 'Final', filePath: '/final.mp4', status: 'ready', durationSeconds: 180, thumbnailSrc: null },
  { id: 'vid-final-error', type: 'final', slug: '@final-render-attempt-03-failed', title: 'Final', filePath: '', status: 'error', durationSeconds: 180, thumbnailSrc: null },
];

const imageMocks: MediaItem[] = [
  { id: 'image-uploading', type: 'image', slug: '@hero', title: 'Banner Hero', filePath: '', status: 'uploading', width: 1920, height: 1080, origin: 'nano_banana', thumbnailSrc: null },
  { id: 'image-loading', type: 'image', slug: '@processing-image', title: 'Processing Image', filePath: '/opengraph.jpg', status: 'loading', width: 1920, height: 1080, origin: 'nano_banana', thumbnailSrc: null },
  { id: 'image-generating', type: 'image', slug: '@product-shot-lifestyle-v3', title: 'Product Shot', filePath: '', status: 'generating', width: 1024, height: 1024, origin: 'gpt15_imagen', thumbnailSrc: null },
  { id: 'image-downloading', type: 'image', slug: '@bg', title: 'Background', filePath: '', status: 'downloading', width: 3840, height: 2160, origin: 'nano_banana', thumbnailSrc: null },
  { id: 'image-ready', type: 'image', slug: '@logo-final', title: 'Logo Final', filePath: '/opengraph.jpg', status: 'ready', width: 512, height: 512, origin: 'nano_banana', thumbnailSrc: null },
  { id: 'image-error', type: 'image', slug: '@broken-image-corrupted', title: 'Broken Image', filePath: '', status: 'error', width: 1920, height: 1080, origin: 'gpt15_imagen', thumbnailSrc: null },
  { id: 'image-corrupt', type: 'image', slug: '@corrupted-texture', title: 'Corrupted Texture', filePath: '', status: 'corrupt', width: 1024, height: 1024, origin: 'nano_banana', thumbnailSrc: null },
];

const scriptMocks: MediaItem[] = [
  { id: 'script-uploading', type: 'script', slug: '@intro-script', title: 'Intro Script', filePath: '', status: 'uploading' },
  { id: 'script-loading', type: 'script', slug: '@processing-script', title: 'Processing Script', filePath: '/script.txt', status: 'loading' },
  { id: 'script-generating', type: 'script', slug: '@narration', title: 'Narration', filePath: '', status: 'generating' },
  { id: 'script-ready', type: 'script', slug: '@voiceover', title: 'Voiceover', filePath: '/script.txt', status: 'ready', prompt: 'Scene 1: Wide establishing shot of the city skyline at golden hour. Camera slowly pans right to reveal the protagonist.\n\nScene 2: Close-up of hands typing on a laptop. Cut to screen showing data visualization.\n\nScene 3: Interview segment with soft key light.' },
  { id: 'script-error', type: 'script', slug: '@broken-script', title: 'Broken Script', filePath: '', status: 'error' },
  { id: 'script-corrupt', type: 'script', slug: '@garbled-dialogue', title: 'Garbled Dialogue', filePath: '', status: 'corrupt' },
];

const audioMocks: MediaItem[] = [
  { id: 'audio-uploading', type: 'audio', slug: '@narration-take-1', title: 'Narration Take 1', filePath: '', status: 'uploading' },
  { id: 'audio-loading', type: 'audio', slug: '@processing-audio', title: 'Processing Audio', filePath: '/sample.mp3', status: 'loading' },
  { id: 'audio-generating', type: 'audio', slug: '@voiceover-v2', title: 'Voiceover V2', filePath: '', status: 'generating' },
  { id: 'audio-downloading', type: 'audio', slug: '@background-music', title: 'Background Music', filePath: '', status: 'downloading' },
  { id: 'audio-ready', type: 'audio', slug: '@final-mix', title: 'Final Mix', filePath: '/sample.mp3', status: 'ready' },
  { id: 'audio-error', type: 'audio', slug: '@broken-recording', title: 'Broken Recording', filePath: '', status: 'error' },
  { id: 'audio-corrupt', type: 'audio', slug: '@garbled-audio', title: 'Garbled Audio', filePath: '', status: 'corrupt' },
];

const planMocks: MediaItem[] = [
  { id: 'plan-uploading', type: 'plan', slug: '@plan', title: 'Plan', filePath: '', status: 'uploading' },
  { id: 'plan-loading', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'loading' },
  { id: 'plan-generating', type: 'plan', slug: '@plan', title: 'Plan', filePath: '', status: 'generating' },
  { id: 'plan-ready-empty', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready' },
  { id: 'plan-ready-text', type: 'plan', slug: '@plan', title: 'Plan', filePath: '/plan.md', status: 'ready', prompt: 'Scene 1: Wide establishing shot of the city skyline at golden hour. Camera slowly pans right to reveal the protagonist standing on a rooftop.\n\nScene 2: Close-up of hands typing on a laptop. Cut to screen showing data visualization.\n\nScene 3: Interview segment with soft key light.' },
  { id: 'plan-error', type: 'plan', slug: '@plan', title: 'Plan', filePath: '', status: 'error' },
  { id: 'plan-corrupt', type: 'plan', slug: '@plan', title: 'Plan', filePath: '', status: 'corrupt' },
];

const planIdLabels: Record<string, string> = {
  'plan-ready-empty': 'ready (empty)',
  'plan-ready-text': 'ready (with text)',
};

// ── Badge Mocks ──

const slugBadgeMocks: { id: string; label: string; props: { slug: string; colorScheme: 'cyan' | 'gold'; isError: boolean; isProcessing?: boolean } }[] = [
  { id: 'slug-cyan', label: 'cyan', props: { slug: '@hero-intro', colorScheme: 'cyan', isError: false } },
  { id: 'slug-cyan-error', label: 'cyan error', props: { slug: '@broken-clip', colorScheme: 'cyan', isError: true } },
  { id: 'slug-cyan-processing', label: 'cyan processing', props: { slug: '@rendering-v2', colorScheme: 'cyan', isError: false, isProcessing: true } },
  { id: 'slug-gold', label: 'gold', props: { slug: '@final-export-v2', colorScheme: 'gold', isError: false } },
  { id: 'slug-gold-error', label: 'gold error', props: { slug: '@final-render-failed', colorScheme: 'gold', isError: true } },
  { id: 'slug-long', label: 'truncation', props: { slug: '@customer-interview-segment-final-cut-v3-extended-remaster', colorScheme: 'cyan', isError: false } },
];

const durationBadgeMocks: { id: string; label: string; props: { duration: string; isProcessing: boolean } }[] = [
  { id: 'dur-30s', label: '30s', props: { duration: '0:30', isProcessing: false } },
  { id: 'dur-2m', label: '2m', props: { duration: '2:00', isProcessing: false } },
  { id: 'dur-1h', label: '1h', props: { duration: '1:00:00', isProcessing: false } },
  { id: 'dur-processing', label: 'processing', props: { duration: '0:45', isProcessing: true } },
];

const resolutionBadgeMocks: { id: string; label: string; props: { width: number; height: number } }[] = [
  { id: 'res-1080p', label: '1080p landscape', props: { width: 1920, height: 1080 } },
  { id: 'res-portrait', label: '1080p portrait', props: { width: 1080, height: 1920 } },
  { id: 'res-square', label: 'square', props: { width: 512, height: 512 } },
  { id: 'res-4k', label: '4K', props: { width: 3840, height: 2160 } },
];

// ── Helper Components ──

function getStateLabel(item: MediaItem, labelOverrides?: Record<string, string>): string {
  const status = item.status || 'ready';
  return labelOverrides?.[item.id] ?? labelOverrides?.[status] ?? status;
}

function CardSection({ title, colorClass, children }: { title: string; colorClass: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className={`text-xl font-mono font-bold border-b border-border pb-2 ${colorClass}`}>{title}</h2>
      <div className="flex flex-wrap gap-6">
        {children}
      </div>
    </section>
  );
}

function CardWrapper({ item, labelOverrides, children }: { item: MediaItem; labelOverrides?: Record<string, string>; children: React.ReactNode }) {
  const stateLabel = getStateLabel(item, labelOverrides);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{stateLabel}</span>
      <div className="w-[200px]">{children}</div>
    </div>
  );
}

function CardBadgesSection() {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-mono font-bold border-b border-border pb-2 text-blue-400">Card Badges</h2>

      {/* SlugBadge */}
      <h3 className="text-sm font-mono font-bold text-blue-400/70">SlugBadge</h3>
      <div className="flex flex-wrap gap-4 mb-6">
        {slugBadgeMocks.map((mock) => (
          <div key={mock.id} className="flex flex-col gap-2">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{mock.label}</span>
            <div className="w-[200px] h-[60px] relative overflow-hidden border border-border/50 rounded bg-zinc-900">
              <SlugBadge {...mock.props} />
            </div>
          </div>
        ))}
      </div>

      {/* DurationBadge */}
      <h3 className="text-sm font-mono font-bold text-blue-400/70">DurationBadge</h3>
      <div className="flex flex-wrap gap-4 mb-6">
        {durationBadgeMocks.map((mock) => (
          <div key={mock.id} className="flex flex-col gap-2">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{mock.label}</span>
            <div className="w-[120px] h-[50px] relative overflow-hidden border border-border/50 rounded bg-zinc-900">
              <DurationBadge {...mock.props} />
            </div>
          </div>
        ))}
      </div>

      {/* ResolutionBadge */}
      <h3 className="text-sm font-mono font-bold text-blue-400/70">ResolutionBadge</h3>
      <div className="flex flex-wrap gap-4">
        {resolutionBadgeMocks.map((mock) => (
          <div key={mock.id} className="flex flex-col gap-2">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{mock.label}</span>
            <div className="w-[120px] h-[50px] relative overflow-hidden border border-border/50 rounded bg-zinc-900">
              <ResolutionBadge {...mock.props} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReceivingGhostCardSection() {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-mono font-bold border-b border-border pb-2 text-primary">ReceivingGhostCard</h2>
      <div className="w-[200px]">
        <ReceivingGhostCard filename="hero-intro-final.mp4" />
      </div>
    </section>
  );
}

// ── Main Styleguide ──

export function Styleguide() {
  return (
    <div className="min-h-screen p-8 max-w-7xl mx-auto space-y-12">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-primary">Styleguide</h1>
        <Link href="/" className="text-sm text-muted-foreground hover:text-primary transition-colors">
          &larr; Dashboard
        </Link>
      </header>

      {/* Colors + Typography + Buttons — compact row */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Colors */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold border-b border-border pb-1">Colors</h2>
          <div className="grid grid-cols-4 gap-1.5">
            {colors.map((c) => (
              <div key={c.name} className={`${c.bg} ${c.fg} rounded px-2 py-1.5 text-center text-[10px] font-medium border border-border`}>
                {c.name}
              </div>
            ))}
          </div>
        </div>

        {/* Typography */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold border-b border-border pb-1">Typography</h2>
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
          <h2 className="text-lg font-semibold border-b border-border pb-1">Buttons</h2>
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

      {/* Cards + Inputs + Utilities — compact row */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Cards */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold border-b border-border pb-1">Cards</h2>
          <div className="space-y-3">
            <Card className="py-3">
              <CardHeader className="px-4 py-0">
                <CardTitle className="text-sm">Default Card</CardTitle>
              </CardHeader>
              <CardContent className="px-4 py-0">
                <p className="text-xs text-muted-foreground">Standard card with border and shadow</p>
              </CardContent>
            </Card>
            <Card className="border-primary border-glow py-3">
              <CardHeader className="px-4 py-0">
                <CardTitle className="text-sm text-primary">Highlighted Card</CardTitle>
              </CardHeader>
              <CardContent className="px-4 py-0">
                <p className="text-xs text-muted-foreground">With border-glow utility</p>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Inputs */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold border-b border-border pb-1">Inputs</h2>
          <div className="space-y-2">
            <Input placeholder="Default input..." />
            <Input placeholder="Disabled" disabled />
          </div>
        </div>

        {/* Custom Utilities */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold border-b border-border pb-1">Custom Utilities</h2>
          <div className="grid grid-cols-2 gap-2">
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
        </div>
      </section>

      {/* ==================== MEDIA CARD SECTIONS ==================== */}

      {/* VideoCard */}
      <CardSection title="VideoCard" colorClass="text-primary">
        {videoMocks.map((item) => (
          <CardWrapper key={item.id} item={item} labelOverrides={videoStateLabels}>
            <VideoCard item={item} />
          </CardWrapper>
        ))}
      </CardSection>

      {/* FinalVideoCard */}
      <CardSection title="FinalVideoCard" colorClass="text-amber-400">
        {finalMocks.map((item) => (
          <CardWrapper key={item.id} item={item}>
            <FinalVideoCard item={item} />
          </CardWrapper>
        ))}
      </CardSection>

      {/* ImageCard */}
      <CardSection title="ImageCard" colorClass="text-primary">
        {imageMocks.map((item) => (
          <CardWrapper key={item.id} item={item}>
            <ImageCard item={item} />
          </CardWrapper>
        ))}
      </CardSection>

      {/* ScriptCard */}
      <CardSection title="ScriptCard" colorClass="text-primary">
        {scriptMocks.map((item) => (
          <CardWrapper key={item.id} item={item}>
            <ScriptCard item={item} />
          </CardWrapper>
        ))}
      </CardSection>

      {/* AudioCard */}
      <CardSection title="AudioCard" colorClass="text-blue-400">
        {audioMocks.map((item) => (
          <CardWrapper key={item.id} item={item}>
            <AudioCard item={item} />
          </CardWrapper>
        ))}
      </CardSection>

      {/* PlanCard */}
      <CardSection title="PlanCard" colorClass="text-indigo-400">
        {planMocks.map((item) => (
          <CardWrapper key={item.id} item={item} labelOverrides={planIdLabels}>
            <PlanCard item={item} />
          </CardWrapper>
        ))}
      </CardSection>

      {/* ReceivingGhostCard */}
      <ReceivingGhostCardSection />

      {/* Card Badges */}
      <CardBadgesSection />

    </div>
  );
}
