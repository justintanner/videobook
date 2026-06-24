// The vertical join drawn between two stacked nodes. A centered 1px line; when
// `onAdd` is supplied it carries an interactive "+" chip (the n8n insert
// affordance) — wired only where an insert is meaningful (clip_show: add joke,
// storyboard: add source image). Between fixed pipeline steps it renders as a
// passive connector (no button), NOT dead UI.
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

const LINE = 'w-px bg-zinc-700/60';

export function FlowConnector({
  onAdd,
  addTitle,
  height = 30,
}: {
  onAdd?: () => void;
  addTitle?: string;
  height?: number;
}) {
  return (
    <div
      className="flex shrink-0 flex-col items-center justify-center"
      style={{ height }}
      aria-hidden={onAdd ? undefined : true}
    >
      {onAdd ? (
        <>
          <div className={cn(LINE, 'flex-1')} />
          <button
            type="button"
            onClick={onAdd}
            title={addTitle ?? 'Add step'}
            aria-label={addTitle ?? 'Add step'}
            className={cn(
              'my-0.5 flex h-5 w-5 items-center justify-center rounded border transition-colors',
              'border-zinc-700 bg-zinc-900 text-zinc-400',
              'hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:text-emerald-300',
            )}
          >
            <Plus className="h-3 w-3" />
          </button>
          <div className={cn(LINE, 'flex-1')} />
        </>
      ) : (
        <div className={cn(LINE, 'h-full')} />
      )}
    </div>
  );
}
