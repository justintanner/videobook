import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef, ElementRef } from 'react';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { DISABLED_STATE, FOCUS_RING_BUTTON } from '@/components/ui/interaction-states';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface DialogContentProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  fullScreen?: boolean
}

const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, fullScreen = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-[101] flex flex-col overflow-hidden',
        fullScreen
          ? 'inset-0 bg-zinc-950 border-0 rounded-none shadow-none'
          : 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-neutral-900 border border-neutral-700/60 rounded-lg shadow-2xl',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        !fullScreen && 'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-5 py-3 border-b border-neutral-700/60 bg-neutral-900/95',
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('font-mono text-xs tracking-widest text-neutral-300 uppercase', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-neutral-400', className)}
      {...props}
    />
  );
}

function DialogCloseButton({ className, ...props }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'w-6 h-6 flex items-center justify-center text-neutral-400 transition-colors duration-150 rounded',
        FOCUS_RING_BUTTON,
        'hover:text-neutral-100 hover:bg-neutral-700/50',
        'focus-visible:ring-neutral-400/60',
        DISABLED_STATE,
        className,
      )}
      {...props}
    >
      <X className="w-4 h-4 stroke-[2.5]" />
    </button>
  );
}

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogCloseButton,
};
