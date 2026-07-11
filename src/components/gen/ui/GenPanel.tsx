import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { GenFrame } from './GenFrame';
import { CloseButton } from '@/components/ui/CloseButton';
import type { Domain } from '@/theme/domains';

const HEADER_LABEL_TEXT: Record<Domain, string> = {
  projects: 'text-zinc-300/70',
  image: 'text-cyan-300/70',
  video: 'text-violet-300/70',
  notebook: 'text-emerald-300/70',
  final: 'text-amber-300/70',
};

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
  domain?: Domain;
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
  domain = 'image',
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

  const headerText = HEADER_LABEL_TEXT[domain];
  const header = (
    <div className="flex items-center justify-between px-3 py-3 shrink-0 border-b border-zinc-800/60 bg-black/60">
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <span className={`${headerText} [&>svg]:w-3.5 [&>svg]:h-3.5`}>{icon}</span>
        <span className={`text-xs font-mono font-bold ${headerText}`}>{label}</span>
      </div>
      <div className="flex items-center gap-1">
        {headerExtra}
        {closeHidden ? headerRight : <CloseButton onClick={onClose} disabled={closeDisabled} title="Close (ESC)" />}
      </div>
    </div>
  );

  const footerEl = footer ? <div className="shrink-0 p-2.5 border-t border-zinc-800/60 bg-black/60">{footer}</div> : null;

  return (
    <GenFrame header={header} footer={footerEl} className={className}>
      {children}
    </GenFrame>
  );
}
