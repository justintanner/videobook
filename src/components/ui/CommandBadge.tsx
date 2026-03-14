import { cn } from '@/lib/utils';

type ColorScheme = 'cyan' | 'amber' | 'violet';

interface CommandBadgeProps {
  value: string;
  colorScheme: ColorScheme;
}

const colorClasses: Record<ColorScheme, string> = {
  cyan: 'text-primary border-primary/30 bg-primary/10',
  amber: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
  violet: 'text-violet-400 border-violet-400/30 bg-violet-400/10',
};

export function CommandBadge({ value, colorScheme }: CommandBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded font-mono text-xs font-bold border',
        colorClasses[colorScheme]
      )}
    >
      {value}
    </span>
  );
}
