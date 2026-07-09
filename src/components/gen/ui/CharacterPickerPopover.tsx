import { useState, useEffect, useRef } from 'react';
import { X, Plus, Loader2, User, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import { useGoogleFlowEntities, type GoogleFlowEntityOption } from '@/hooks/useGoogleFlowEntities';
import type { UseMcpResult } from 'use-mcp/react';
import { nameFromAsset, type SlotAsset } from '@/components/gen/ui/google-flow-character-slots';
import type { Domain } from '@/theme/domains';

const POPOVER_BORDER: Record<Domain, string> = {
  projects: 'border-zinc-400/30',
  image: 'border-cyan-400/30',
  video: 'border-violet-400/30',
  plan: 'border-emerald-400/30',
  final: 'border-amber-400/30',
};

interface CharacterPickerPopoverProps {
  selectedRefs: string[];
  onChange: (refs: string[]) => void;
  maxItems: number;
  disabled?: boolean;
  callTool?: UseMcpResult['callTool'];
  mcpState?: UseMcpResult['state'];
  projectSlug?: string;
  domain?: Domain;
}

export function CharacterPickerPopover({
  selectedRefs,
  onChange,
  maxItems,
  disabled,
  callTool,
  mcpState,
  projectSlug,
  domain = 'video',
}: CharacterPickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [createName, setCreateName] = useState('');
  const [primarySlot, setPrimarySlot] = useState<SlotAsset | null>(null);
  const [altSlot, setAltSlot] = useState<SlotAsset | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const { entities, systemEntities, userEntities, loading, loaded, ensureLoaded, refresh } =
    useGoogleFlowEntities('character', callTool, mcpState);

  useEffect(() => {
    if (!open) return;
    void ensureLoaded();
  }, [open, ensureLoaded]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreateMode(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectedSet = new Set(selectedRefs);
  const atCap = selectedRefs.length >= maxItems;
  const borderClass = POPOVER_BORDER[domain];
  const bgClass = 'bg-zinc-950/95';

  function toggleRef(ref: string) {
    if (selectedSet.has(ref)) {
      onChange(selectedRefs.filter((r) => r !== ref));
    } else if (!atCap) {
      onChange([...selectedRefs, ref]);
    }
  }

  async function handleCreate() {
    if (!callTool || !projectSlug) return;
    const images = [primarySlot?.slug, altSlot?.slug].filter((s): s is string => !!s && s.trim() !== '');
    if (images.length === 0) {
      setCreateError('Drop an image');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const result = await callTool('create_google_flow_character', {
        project_slug: projectSlug,
        display_name: createName.trim() || nameFromAsset(primarySlot) || 'Character',
        image_slugs: images,
      });
      const content = result.content as Array<{ type: string; text: string }> | undefined;
      if (result.isError) {
        setCreateError(content?.[0]?.text ?? 'Failed');
        return;
      }
      const parsed = JSON.parse(content?.[0]?.text ?? '{}') as { character_ref?: string };
      if (parsed.character_ref && !atCap) {
        onChange([...selectedRefs, parsed.character_ref]);
      }
      setCreateName('');
      setPrimarySlot(null);
      setAltSlot(null);
      setCreateMode(false);
      void refresh();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={cn(
          'shrink-0 flex items-center gap-1 px-2 h-8 rounded border border-dashed',
          'text-[10px] font-mono tracking-wider transition-colors duration-150',
          disabled ? 'opacity-40 cursor-not-allowed' : 'hover:border-primary/40 hover:bg-primary/5',
          'text-primary/30',
        )}
      >
        <Plus className="w-3 h-3" />
        <span>CHAR</span>
      </button>
    );
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => { setOpen(false); setCreateMode(false); }}
        className={cn(
          'shrink-0 flex items-center gap-1 px-2 h-8 rounded border',
          'text-[10px] font-mono tracking-wider',
          borderClass, 'text-primary/50',
        )}
      >
        <User className="w-3 h-3" />
        <span>CHAR</span>
      </button>
      <div className={cn('absolute top-full left-0 mt-1 w-72 max-h-80 rounded border z-50 overflow-hidden', borderClass, bgClass)}>
        {createMode ? (
          <CreateCharacterForm
            createName={createName}
            setCreateName={setCreateName}
            primarySlot={primarySlot}
            setPrimarySlot={setPrimarySlot}
            altSlot={altSlot}
            setAltSlot={setAltSlot}
            creating={creating}
            createError={createError}
            onCreate={handleCreate}
            onCancel={() => { setCreateMode(false); setCreateError(null); }}
          />
        ) : (
          <CharacterList
            systemEntities={systemEntities}
            userEntities={userEntities}
            selectedSet={selectedSet}
            loading={loading}
            loaded={loaded}
            onToggle={toggleRef}
            onOpenCreate={() => setCreateMode(true)}
            atCap={atCap}
            entities={entities}
          />
        )}
      </div>
    </div>
  );
}

function CharacterList({
  systemEntities,
  userEntities,
  selectedSet,
  loading,
  loaded,
  onToggle,
  onOpenCreate,
  atCap,
  entities,
}: {
  systemEntities: GoogleFlowEntityOption[];
  userEntities: GoogleFlowEntityOption[];
  selectedSet: Set<string>;
  loading: boolean;
  loaded: boolean;
  onToggle: (ref: string) => void;
  onOpenCreate: () => void;
  atCap: boolean;
  entities: GoogleFlowEntityOption[];
}) {
  return (
    <div className="flex flex-col max-h-80">
      <div className="flex items-center justify-between px-3 py-2 border-b border-primary/10">
        <span className="text-[9px] font-mono uppercase tracking-wider text-primary/40">Characters</span>
        <button
          type="button"
          onClick={onOpenCreate}
          className="text-[9px] font-mono text-cyan-400/60 hover:text-cyan-400 transition-colors"
        >
          + new
        </button>
      </div>
      <div className="overflow-y-auto flex-1">
        {loading && !loaded && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-3 h-3 animate-spin text-primary/30" />
          </div>
        )}
        {entities.length === 0 && loaded && (
          <p className="px-3 py-4 text-[10px] font-mono text-primary/30 text-center">
            No characters. Create one.
          </p>
        )}
        {userEntities.length > 0 && (
          <EntityGroup label="yours" entities={userEntities} selectedSet={selectedSet} onToggle={onToggle} atCap={atCap} />
        )}
        {systemEntities.length > 0 && (
          <EntityGroup label="system" entities={systemEntities} selectedSet={selectedSet} onToggle={onToggle} atCap={atCap} />
        )}
      </div>
    </div>
  );
}

function EntityGroup({
  label,
  entities,
  selectedSet,
  onToggle,
  atCap,
}: {
  label: string;
  entities: GoogleFlowEntityOption[];
  selectedSet: Set<string>;
  onToggle: (ref: string) => void;
  atCap: boolean;
}) {
  return (
    <div>
      <div className="px-3 pt-1.5 pb-0.5 text-[8px] font-mono uppercase tracking-wider text-primary/20">{label}</div>
      {entities.map((e) => {
        const isSelected = selectedSet.has(e.ref);
        return (
          <button
            key={e.ref}
            type="button"
            onClick={() => onToggle(e.ref)}
            disabled={!isSelected && atCap}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors',
              'hover:bg-primary/5 disabled:opacity-30 disabled:cursor-not-allowed',
            )}
          >
            <div className="w-6 h-6 rounded overflow-hidden shrink-0 border border-primary/20 flex items-center justify-center bg-black/60">
              {e.thumbnailUrl ? (
                <img src={e.thumbnailUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <User className="w-3 h-3 text-primary/20" />
              )}
            </div>
            <span className="text-[10px] font-mono text-primary/60 truncate flex-1">{e.displayName}</span>
            {isSelected && <Check className="w-3 h-3 text-cyan-400 shrink-0" />}
          </button>
        );
      })}
    </div>
  );
}

function CreateCharacterForm({
  createName,
  setCreateName,
  primarySlot,
  setPrimarySlot,
  altSlot,
  setAltSlot,
  creating,
  createError,
  onCreate,
  onCancel,
}: {
  createName: string;
  setCreateName: (v: string) => void;
  primarySlot: SlotAsset | null;
  setPrimarySlot: (v: SlotAsset | null) => void;
  altSlot: SlotAsset | null;
  setAltSlot: (v: SlotAsset | null) => void;
  creating: boolean;
  createError: string | null;
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono uppercase tracking-wider text-primary/40">New Character</span>
        <button type="button" onClick={onCancel} className="text-primary/30 hover:text-primary/60">
          <X className="w-3 h-3" />
        </button>
      </div>
      <input
        type="text"
        value={createName}
        onChange={(e) => setCreateName(e.target.value)}
        placeholder="Name"
        className="w-full px-2 py-1.5 bg-black/60 border border-primary/20 rounded text-[10px] font-mono text-primary/70 focus:outline-none focus:border-primary/40"
      />
      <div className="flex gap-1.5">
        <AssetDropSlot
          value={primarySlot ? { slug: primarySlot.slug, src: primarySlot.thumbnailSrc || primarySlot.src, type: 'image' } : null}
          onChange={(asset) => {
            if (asset) {
              setPrimarySlot({ slug: asset.slug, src: asset.src, thumbnailSrc: asset.thumbnailSrc, type: 'image' });
            } else {
              setPrimarySlot(null);
            }
          }}
          acceptTypes={['image']}
          compact
        />
        <AssetDropSlot
          value={altSlot ? { slug: altSlot.slug, src: altSlot.thumbnailSrc || altSlot.src, type: 'image' } : null}
          onChange={(asset) => {
            if (asset) {
              setAltSlot({ slug: asset.slug, src: asset.src, thumbnailSrc: asset.thumbnailSrc, type: 'image' });
            } else {
              setAltSlot(null);
            }
          }}
          acceptTypes={['image']}
          compact
        />
      </div>
      {createError && (
        <p className="text-[9px] font-mono text-red-400/80">{createError}</p>
      )}
      <button
        type="button"
        onClick={onCreate}
        disabled={creating || !primarySlot?.slug}
        className={cn(
          'w-full h-7 rounded text-[10px] font-mono tracking-wider',
          'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30',
          'hover:bg-cyan-500/30 transition-colors',
          'disabled:opacity-40 cursor-not-allowed',
        )}
      >
        {creating ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : 'CREATE'}
      </button>
    </div>
  );
}
