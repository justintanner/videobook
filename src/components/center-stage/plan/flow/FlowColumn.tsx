// Centered vertical column that hosts a plan's node graph (n8n idiom). Shared by
// all three formula stacks. An optional sticky header floats above a centered
// column of node groups; connectors (FlowConnector) supply the vertical spacing
// between them, so the column itself is gap-less.
import { cn } from '@/lib/utils';

export function FlowColumn({
  header,
  children,
  className,
}: {
  header?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto flex w-full max-w-2xl flex-col items-stretch', className)} data-flow-column>
      {header != null && (
        <div className="sticky top-0 z-10 mb-2 bg-zinc-950/85 py-2 backdrop-blur-sm">{header}</div>
      )}
      <div className="flex flex-col items-center">{children}</div>
    </div>
  );
}

// Centers one step (a single node card, or a side-by-side row of cards) in the
// column. Use a row of cards as children for branching steps (e.g. char_swap's
// two source/swap frames).
export function FlowStep({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex w-full justify-center', className)}>{children}</div>;
}
