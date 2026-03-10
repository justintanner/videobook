import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface GenFrameProps {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function GenFrame({ children, header, footer, className }: GenFrameProps) {
  return (
    <div className={cn('relative w-full h-full overflow-hidden bg-gradient-to-b from-cyan-950/30 via-black to-black', className)}>
      {/* Scanlines overlay — CRT monitor effect */}
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

      {/* Inner content frame */}
      <div
        className={cn(
          'relative z-20 h-full flex flex-col gap-2',
          'border-2 border-cyan-400/50',
          'shadow-[0_0_30px_-10px_rgba(0,255,255,0.3)]'
        )}
      >
        {header}
        {children}
        {footer}
      </div>
    </div>
  );
}
