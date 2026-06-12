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
    <ToastProvider swipeDirection="right">
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        const Icon = getToastIcon(variant);
        const isDestructive = variant === 'destructive';

        return (
          <Toast key={id} variant={variant} className="activity-scanlines" {...props}>
            <Icon
              className={cn(
                'w-3.5 h-3.5 mt-0.5 shrink-0',
                isDestructive
                  ? 'text-red-300 drop-shadow-[0_0_6px_rgba(239,68,68,0.75)]'
                  : 'text-emerald-300 drop-shadow-[0_0_6px_rgba(16,185,129,0.55)]'
              )}
            />

            <div className="flex-1 min-w-0 grid gap-1">
              {title && (
                <ToastTitle
                  className={cn(
                    isDestructive
                      ? 'text-red-300 drop-shadow-[0_0_6px_rgba(239,68,68,0.55)]'
                      : 'text-emerald-300 drop-shadow-[0_0_6px_rgba(16,185,129,0.55)]'
                  )}
                >
                  [{title}]
                </ToastTitle>
              )}
              {description && (
                <ToastDescription className={isDestructive ? 'text-red-200/90' : 'text-emerald-100/80'}>
                  {description}
                </ToastDescription>
              )}
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
