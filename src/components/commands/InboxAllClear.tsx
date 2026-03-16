import { CheckCircle2 } from 'lucide-react';

export function InboxAllClear() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6">
      <CheckCircle2 className="w-12 h-12 text-primary mb-3" />
      <span className="text-sm font-mono font-bold tracking-widest text-primary uppercase">ALL_CLEAR</span>
    </div>
  );
}
