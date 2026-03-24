import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { GenFrame } from './GenFrame';
import { CloseButton } from './CloseButton';

interface GenPanelProps {
  label: string;
  icon: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  closeHidden?: boolean;
  headerExtra?: ReactNode;
  headerRight?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function GenPanel({
  label,
  icon,
  onClose,
  closeDisabled,
  closeHidden,
  headerExtra,
  headerRight,
  footer,
  children,
  className,
}: GenPanelProps) {
  useEffect(() => {
    if (closeDisabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeDisabled, onClose]);

  const header = (
    <div
      className={cn(
        'flex items-center justify-between px-3 py-3 shrink-0',
        'border-b-2 border-inherit',
        'bg-black/50 backdrop-blur-sm'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-cyan-400 drop-shadow-[0_0_6px_#22d3ee] [&>svg]:w-4 [&>svg]:h-4">{icon}</span>
        <span className="text-sm font-bold tracking-[0.15em] text-cyan-400">{label}</span>
      </div>
      <div className="flex items-center gap-1">
        {headerExtra}
        {closeHidden ? headerRight : <CloseButton onClick={onClose} disabled={closeDisabled} />}
      </div>
    </div>
  );

  const footerEl = footer ? <div className="shrink-0 p-2.5 border-t-2 border-inherit bg-black/30">{footer}</div> : null;

  return (
    <GenFrame header={header} footer={footerEl} className={className}>
      {children}
    </GenFrame>
  );
}
