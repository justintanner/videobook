import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

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

export function Styleguide() {
  return (
    <div className="min-h-screen p-8 max-w-5xl mx-auto space-y-12">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-primary">Styleguide</h1>
        <Link href="/" className="text-sm text-muted-foreground hover:text-primary transition-colors">
          &larr; Dashboard
        </Link>
      </header>

      {/* Colors */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold border-b border-border pb-2">Colors</h2>
        <div className="grid grid-cols-4 gap-3">
          {colors.map((c) => (
            <div key={c.name} className={`${c.bg} ${c.fg} rounded-lg p-4 text-center text-sm font-medium border border-border`}>
              {c.name}
            </div>
          ))}
        </div>
      </section>

      {/* Typography */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold border-b border-border pb-2">Typography</h2>
        <div className="space-y-3">
          <p className="text-3xl font-bold">Rajdhani Bold (font-sans)</p>
          <p className="text-2xl font-semibold">Rajdhani Semibold</p>
          <p className="text-xl font-medium">Rajdhani Medium</p>
          <p className="text-base font-normal">Rajdhani Regular — The quick brown fox jumps over the lazy dog.</p>
          <p className="text-base font-light">Rajdhani Light</p>
          <p className="font-mono text-base">JetBrains Mono (font-mono) — 0123456789 {'{}'}</p>
          <p className="font-mono text-sm text-muted-foreground">const x = await fetchData();</p>
        </div>
      </section>

      {/* Buttons */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold border-b border-border pb-2">Buttons</h2>

        <div className="space-y-6">
          {/* Variants */}
          <div>
            <h3 className="text-sm text-muted-foreground mb-3">Variants</h3>
            <div className="flex flex-wrap gap-3">
              {variants.map((v) => (
                <Button key={v} variant={v}>{v}</Button>
              ))}
            </div>
          </div>

          {/* Sizes */}
          <div>
            <h3 className="text-sm text-muted-foreground mb-3">Sizes</h3>
            <div className="flex flex-wrap items-center gap-3">
              {sizes.map((s) => (
                <Button key={s} size={s}>{s === 'icon' ? '?' : s}</Button>
              ))}
            </div>
          </div>

          {/* States */}
          <div>
            <h3 className="text-sm text-muted-foreground mb-3">States</h3>
            <div className="flex flex-wrap gap-3">
              <Button disabled>Disabled</Button>
              <Button variant="destructive" disabled>Disabled Destructive</Button>
              <Button variant="outline" disabled>Disabled Outline</Button>
            </div>
          </div>
        </div>
      </section>

      {/* Cards */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold border-b border-border pb-2">Cards</h2>
        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Default Card</CardTitle>
              <CardDescription>Standard card with border and shadow</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">Card content goes here. Uses bg-card with card-foreground text.</p>
            </CardContent>
            <CardFooter>
              <Button size="sm">Action</Button>
            </CardFooter>
          </Card>

          <Card className="border-primary border-glow">
            <CardHeader>
              <CardTitle className="text-primary">Highlighted Card</CardTitle>
              <CardDescription>With border-glow utility</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">Primary border with inner glow effect for emphasis.</p>
            </CardContent>
            <CardFooter>
              <Button size="sm" variant="outline">Details</Button>
            </CardFooter>
          </Card>
        </div>
      </section>

      {/* Inputs */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold border-b border-border pb-2">Inputs</h2>
        <div className="grid grid-cols-2 gap-4 max-w-lg">
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">Default</label>
            <Input placeholder="Type something..." />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">Disabled</label>
            <Input placeholder="Disabled" disabled />
          </div>
        </div>
      </section>

      {/* Custom Utilities */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold border-b border-border pb-2">Custom Utilities</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-card border border-border p-6 clip-corner-tl">
            <p className="text-sm font-medium">.clip-corner-tl</p>
            <p className="text-xs text-muted-foreground">Top-left corner clipped</p>
          </div>
          <div className="bg-card border border-border p-6 clip-corner-br">
            <p className="text-sm font-medium">.clip-corner-br</p>
            <p className="text-xs text-muted-foreground">Bottom-right corner clipped</p>
          </div>
          <div className="bg-card border border-border p-6 clip-corner-both">
            <p className="text-sm font-medium">.clip-corner-both</p>
            <p className="text-xs text-muted-foreground">Both corners clipped</p>
          </div>
          <div className="bg-card border border-primary p-6 border-glow rounded-lg">
            <p className="text-sm font-medium">.border-glow</p>
            <p className="text-xs text-muted-foreground">Inner glow with primary color</p>
          </div>
          <div className="bg-card border border-border p-6 rounded-lg relative overflow-hidden col-span-2">
            <div className="absolute inset-0 scanlines pointer-events-none" />
            <p className="text-sm font-medium relative">.scanlines</p>
            <p className="text-xs text-muted-foreground relative">Retro CRT scanline overlay</p>
          </div>
        </div>
      </section>
    </div>
  );
}
