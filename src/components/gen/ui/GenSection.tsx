import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { sectionTheme, type Domain, type SectionTheme } from '@/theme/domains';

// `blue` and `fuchsia` are kept as semantic non-domain colors used by a few
// gen-form areas; everything else moves through `Domain`.
export type GenSectionColor = Domain | 'blue' | 'fuchsia';

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

interface GenSectionStyle {
  frame: string;
  header: string;
  label: string;
  required: string;
  warning: string;
  warningBorder: string;
}

function fromDomain(t: SectionTheme, requiredText: string, warning: string, warningBorder: string): GenSectionStyle {
  return {
    frame: cn(t.sectionBorder, t.sectionBg),
    header: cn(t.headerBorder, t.headerBg),
    label: t.headerText,
    required: requiredText,
    warning,
    warningBorder,
  };
}

const COLOR_CLASSES: Record<GenSectionColor, GenSectionStyle> = {
  projects: fromDomain(sectionTheme('projects'), 'text-zinc-400/60', 'text-zinc-300/60', 'border-zinc-500/20'),
  image: fromDomain(sectionTheme('image'), 'text-cyan-400/60', 'text-cyan-300/60', 'border-cyan-500/20'),
  video: fromDomain(sectionTheme('video'), 'text-violet-400/60', 'text-violet-300/60', 'border-violet-500/20'),
  plan: fromDomain(sectionTheme('plan'), 'text-emerald-400/60', 'text-emerald-300/60', 'border-emerald-500/20'),
  final: fromDomain(sectionTheme('final'), 'text-amber-400/60', 'text-amber-300/60', 'border-amber-500/20'),
  blue: {
    frame: 'border-blue-500/15 bg-blue-500/[0.03]',
    header: 'border-blue-500/30 bg-blue-500/15',
    label: 'text-blue-400',
    required: 'text-blue-400/60',
    warning: 'text-blue-300/60',
    warningBorder: 'border-blue-500/20',
  },
  fuchsia: {
    frame: 'border-fuchsia-500/15 bg-fuchsia-500/[0.03]',
    header: 'border-fuchsia-500/30 bg-fuchsia-500/15',
    label: 'text-fuchsia-400',
    required: 'text-fuchsia-400/60',
    warning: 'text-fuchsia-300/60',
    warningBorder: 'border-fuchsia-500/20',
  },
};

export function GenSection({
  label,
  color = 'image',
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
        <span className={cn('font-mono font-bold tracking-widest whitespace-nowrap truncate min-w-0', labelText, c.label)}>/{label}</span>
        {required && (
          <span className={cn('font-bold tracking-wider whitespace-nowrap', requiredText, c.required)}>*REQ</span>
        )}
        {rightSlot && <div className="ml-auto flex items-center gap-3 whitespace-nowrap shrink-0">{rightSlot}</div>}
      </div>
      {warnings.length > 0 && (
        <div className={cn('border-b', c.warningBorder)}>
          {warnings.map((w, i) => (
            <div
              key={i}
              className={cn('px-3 py-1 text-[10px] font-mono italic', c.warning)}
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
