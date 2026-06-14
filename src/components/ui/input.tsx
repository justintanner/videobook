import * as React from 'react';

import { cn } from '@/lib/utils';
import { DISABLED_STATE, FOCUS_RING_INPUT } from '@/components/ui/interaction-states';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground md:text-sm',
          FOCUS_RING_INPUT,
          DISABLED_STATE,
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
