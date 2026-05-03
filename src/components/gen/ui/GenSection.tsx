import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type GenSectionColor = 'emerald' | 'cyan' | 'violet' | 'blue' | 'fuchsia';

interface GenSectionProps {
  label: string;
  color?: GenSectionColor;
  required?: boolean;
  headerSize?: 'sm' | 'md';
  warning?: string | string[] | null;
  rightSlot?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

const COLOR_CLASSES: Record<GenSectionColor, {
  frame: string;
  header: string;
  label: string;
  required: string;
}> = {
  emerald: {
    frame: 'border-emerald-500/15 bg-emerald-500/[0.03]',
    header: 'border-emerald-500/30 bg-emerald-500/15',
    label: 'text-emerald-400',
    required: 'text-emerald-400/60',
  },
  cyan: {
    frame: 'border-cyan-500/15 bg-cyan-500/[0.03]',
    header: 'border-cyan-500/30 bg-cyan-500/15',
    label: 'text-cyan-400',
    required: 'text-cyan-400/60',
  },
  violet: {
    frame: 'border-violet-500/15 bg-violet-500/[0.03]',
    header: 'border-violet-500/30 bg-violet-500/15',
    label: 'text-violet-400',
    required: 'text-violet-400/60',
  },
  blue: {
    frame: 'border-blue-500/15 bg-blue-500/[0.03]',
    header: 'border-blue-500/30 bg-blue-500/15',
    label: 'text-blue-400',
    required: 'text-blue-400/60',
  },
  fuchsia: {
    frame: 'border-fuchsia-500/15 bg-fuchsia-500/[0.03]',
    header: 'border-fuchsia-500/30 bg-fuchsia-500/15',
    label: 'text-fuchsia-400',
    required: 'text-fuchsia-400/60',
  },
};

export function GenSection({
  label,
  color = 'cyan',
  required,
  headerSize = 'sm',
  warning,
  rightSlot,
  className,
  bodyClassName,
  children,
}: GenSectionProps) {
  const c = COLOR_CLASSES[color];
  const headerPadding = headerSize === 'md' ? 'px-4 py-2.5' : 'px-3 py-1.5';
  const headerGap = headerSize === 'md' ? 'gap-3' : 'gap-2';
  const labelText = headerSize === 'md' ? 'text-base' : 'text-xs';
  const requiredText = headerSize === 'md' ? 'text-[10px]' : 'text-[8px]';
  const warnings = normalizeWarnings(warning);
  return (
    <div className={cn('rounded border', c.frame, className)}>
      <div className={cn('flex items-center rounded-t border-b', headerPadding, headerGap, c.header)}>
        <span className={cn('font-mono font-bold tracking-widest', labelText, c.label)}>/{label}</span>
        {required && (
          <span className={cn('font-bold tracking-wider', requiredText, c.required)}>*REQ</span>
        )}
        {rightSlot && <div className="ml-auto flex items-center gap-3">{rightSlot}</div>}
      </div>
      {warnings.length > 0 && (
        <div className="border-b border-yellow-500/15">
          {warnings.map((w, i) => (
            <div
              key={i}
              className="px-3 py-1 text-[10px] font-mono text-yellow-300/90 bg-yellow-500/[0.06]"
            >
              {w}
            </div>
          ))}
        </div>
      )}
      <div className={cn('px-3 py-2.5', bodyClassName)}>{children}</div>
    </div>
  );
}

interface WarningStripProps {
  messages: string[];
  className?: string;
}

export function WarningStrip({ messages, className }: WarningStripProps) {
  if (messages.length === 0) return null;
  return (
    <div className={cn('rounded border border-yellow-500/20 overflow-hidden', className)}>
      {messages.map((m, i) => (
        <div
          key={i}
          className="px-3 py-1.5 text-[10px] font-mono text-yellow-300/90 bg-yellow-500/[0.06]"
        >
          {m}
        </div>
      ))}
    </div>
  );
}

function normalizeWarnings(w: string | string[] | null | undefined): string[] {
  if (!w) return [];
  if (Array.isArray(w)) return w.filter(Boolean);
  return [w];
}
