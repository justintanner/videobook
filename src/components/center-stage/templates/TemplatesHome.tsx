import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/EmptyState';
import { searchTemplates, type TemplateCatalogEntry } from './catalog';
import type { PlanFormula } from '../PlanViewer';

// Marketplace home: searchable grid of template cards. Picking a card opens its
// preview (handled by the parent TemplatesViewer).
export function TemplatesHome({ currentFormula, onOpen }: {
  currentFormula: PlanFormula | null;
  onOpen: (entry: TemplateCatalogEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchTemplates(query), [query]);

  return (
    <div className="min-h-full flex flex-col">
      <div className="mb-5 pb-4 border-b border-zinc-800/70">
        <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-teal-300/45">Plan</div>
        <h1 className="mt-1 text-lg font-bold text-teal-300 font-mono uppercase tracking-wider">Templates</h1>
        <p className="mt-1 text-[11px] font-mono text-teal-300/40">Pick a template to preview and generate a plan.</p>
      </div>

      <div className="mb-4 flex h-9 items-center gap-2 border border-zinc-800 bg-black/40 px-2.5 focus-within:border-teal-400/50">
        <Search className="h-4 w-4 shrink-0 text-zinc-600" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search templates"
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
        />
      </div>

      {results.length === 0 ? (
        <EmptyState>No templates match “{query.trim()}”.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {results.map((entry) => (
            <TemplateCard
              key={entry.id}
              entry={entry}
              isCurrent={currentFormula === entry.id}
              onOpen={() => onOpen(entry)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ entry, isCurrent, onOpen }: {
  entry: TemplateCatalogEntry;
  isCurrent: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'min-h-32 p-4 rounded border text-left transition-colors flex flex-col gap-2.5',
        'bg-zinc-950/50 hover:bg-teal-500/10',
        isCurrent ? 'border-teal-500/65' : 'border-zinc-800/75 hover:border-teal-500/50',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn(
            'w-9 h-9 rounded border flex items-center justify-center shrink-0',
            isCurrent ? 'border-teal-500/70 text-teal-200 bg-teal-500/15' : 'border-zinc-700/80 text-teal-300/65 bg-black/35',
          )}>
            {entry.icon}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-mono font-bold uppercase tracking-wider text-teal-200 truncate">{entry.name}</span>
            <span className="block mt-0.5 text-[10px] font-mono uppercase tracking-wider text-teal-300/40 truncate">{entry.legacy ? 'legacy' : 'template'}</span>
          </span>
        </div>
        {isCurrent && (
          <span className="shrink-0 h-5 px-2 rounded border border-teal-500/40 bg-teal-500/10 text-[9px] font-mono font-bold uppercase tracking-wider text-teal-200/80">
            Current
          </span>
        )}
      </div>
      <p className="text-[11px] font-mono text-teal-300/55 leading-relaxed">{entry.tagline}</p>
    </button>
  );
}
