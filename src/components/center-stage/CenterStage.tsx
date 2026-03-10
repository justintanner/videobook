import { cn } from '@/lib/utils';

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
