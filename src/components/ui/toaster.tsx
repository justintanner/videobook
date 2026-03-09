import { useToast } from '@/hooks/useToast';
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from '@/components/ui/toast';
import { Terminal, AlertTriangle, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

function getToastIcon(variant: string | null | undefined) {
  switch (variant) {
    case 'destructive':
      return AlertTriangle;
    case 'success':
      return CheckCircle;
    default:
      return Terminal;
  }
}

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        const Icon = getToastIcon(variant);
        const isDestructive = variant === 'destructive';

        return (
          <Toast key={id} variant={variant} {...props}>
            {/* Scanline overlay */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-20">
              <div
                className={cn(
                  'absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(0,255,255,0.1)_50%)] bg-[length:100%_4px] animate-cyber-scanline',
                  isDestructive && 'bg-[linear-gradient(transparent_50%,rgba(239,68,68,0.1)_50%)]'
                )}
              />
            </div>

            {/* Shimmer effect */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              <div
                className={cn(
                  'absolute inset-0 bg-gradient-to-r from-transparent via-primary/10 to-transparent -translate-x-full animate-cyber-shimmer',
                  isDestructive && 'via-destructive/10'
                )}
              />
            </div>

            {/* Corner accents */}
            <div
              className={cn(
                'absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-primary/60',
                isDestructive && 'border-destructive/60'
              )}
            />
            <div
              className={cn(
                'absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-primary/60',
                isDestructive && 'border-destructive/60'
              )}
            />
            <div
              className={cn(
                'absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-primary/60',
                isDestructive && 'border-destructive/60'
              )}
            />
            <div
              className={cn(
                'absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-primary/60',
                isDestructive && 'border-destructive/60'
              )}
            />

            {/* Icon with glow */}
            <div className="relative shrink-0">
              <div
                className={cn(
                  'absolute inset-0 blur-md rounded-full animate-pulse',
                  isDestructive ? 'bg-destructive/30' : 'bg-primary/30'
                )}
              />
              <div
                className={cn(
                  'relative w-10 h-10 rounded border flex items-center justify-center',
                  isDestructive ? 'border-destructive/40 bg-destructive/10' : 'border-primary/40 bg-primary/10'
                )}
              >
                <Icon className={cn('w-5 h-5', isDestructive ? 'text-destructive' : 'text-primary')} />
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 grid gap-1 relative z-10">
              {title && (
                <ToastTitle
                  className={cn(
                    'font-mono text-xs uppercase tracking-wider',
                    isDestructive ? 'text-destructive/80' : 'text-primary/80'
                  )}
                >
                  {title}
                </ToastTitle>
              )}
              {description && <ToastDescription className="text-sm font-medium">{description}</ToastDescription>}
            </div>

            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
