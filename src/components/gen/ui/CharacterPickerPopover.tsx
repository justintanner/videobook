import { useState, useEffect, useRef } from 'react';
import { X, Loader2, User, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useGoogleFlowEntities, type GoogleFlowEntityOption } from '@/hooks/useGoogleFlowEntities';
import type { UseMcpResult } from 'use-mcp/react';
import { nameFromAsset } from '@/components/gen/ui/google-flow-character-slots';
import { sectionTheme, type Domain } from '@/theme/domains';

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
  const { entities, loading, ensureLoaded, refresh } =
    useGoogleFlowEntities('character', callTool, mcpState);

  const [isDragOver, setIsDragOver] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [renamingRef, setRenamingRef] = useState<string | null>(null);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  const selectedSet = new Set(selectedRefs);
  const atCap = selectedRefs.length >= maxItems;
  const t = sectionTheme(domain);

  function toggleRef(ref: string) {
    if (selectedSet.has(ref)) {
      onChange(selectedRefs.filter((r) => r !== ref));
    } else if (!atCap) {
      onChange([...selectedRefs, ref]);
    }
  }

  async function handleCreate(slugs: string[], defaultName: string) {
    if (!callTool || !projectSlug) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await callTool('create_google_flow_character', {
        project_slug: projectSlug,
        display_name: defaultName,
        image_slugs: slugs,
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
      void refresh();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (disabled || creating) return;
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled || creating) return;
    try {
      const raw = e.dataTransfer.getData('application/json');
      if (raw) {
        const data = JSON.parse(raw);
        const items = Array.isArray(data) ? data : [data];
        const images = items.filter(item => item && item.type === 'image');
        if (images.length > 0) {
          const slugs = images.slice(0, 2).map(img => img.slug);
          const name = nameFromAsset({ slug: slugs[0], src: '', type: 'image' }) || 'Character';
          void handleCreate(slugs, name);
        }
      }
    } catch (e) {
      console.error('Failed to parse dropped character images', e);
    }
  };

  // Rename recreates the character server-side (useapi.net has no update
  // endpoint), so the ref changes: swap old -> new in the selection.
  async function handleRename(ref: string, newName: string) {
    if (!callTool) return;
    setRenamingRef(ref);
    setCreateError(null);
    try {
      const result = await callTool('rename_google_flow_character', { ref, display_name: newName });
      const content = result.content as Array<{ type: string; text: string }> | undefined;
      if (result.isError) {
        setCreateError(content?.[0]?.text ?? 'Rename failed');
        return;
      }
      const parsed = JSON.parse(content?.[0]?.text ?? '{}') as { character_ref?: string; warning?: string };
      if (parsed.character_ref && selectedSet.has(ref)) {
        onChange(selectedRefs.map((r) => (r === ref ? parsed.character_ref! : r)));
      }
      if (parsed.warning) setCreateError(parsed.warning);
      void refresh();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenamingRef(null);
    }
  }

  async function handleDelete(ref: string) {
    if (!callTool) return;
    try {
      await callTool('delete_google_flow_character', { ref });
      if (selectedSet.has(ref)) {
        onChange(selectedRefs.filter((r) => r !== ref));
      }
      void refresh();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="w-full flex flex-col gap-2 relative">
      <div 
        className={cn(
          "w-full flex flex-wrap gap-2 p-2 rounded border min-h-[48px] items-center transition-colors relative",
          isDragOver ? cn(t.activeBorder, "bg-primary/10") : cn(t.controlBorder, "bg-black/40"),
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10 pointer-events-none rounded">
            <span className="text-[10px] font-mono tracking-wider text-primary/80">DROP IMAGES TO CREATE</span>
          </div>
        )}
        
        {entities.length === 0 && !loading && !creating && (
          <span className="text-[10px] font-mono text-primary/40 italic px-1">
            Drag images here to create characters
          </span>
        )}
        
        {entities.map(e => (
          <CharacterChip 
            key={e.ref}
            entity={e}
            isSelected={selectedSet.has(e.ref)}
            onToggle={() => toggleRef(e.ref)}
            onRename={(newName) => handleRename(e.ref, newName)}
            onDelete={() => handleDelete(e.ref)}
            renaming={renamingRef === e.ref}
            disabled={(!selectedSet.has(e.ref) && atCap) || disabled}
          />
        ))}

        {creating && (
          <div className="flex items-center gap-2 px-2 py-1 rounded border border-cyan-400/30 bg-cyan-500/10 h-8">
            <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
            <span className="text-[10px] font-mono text-cyan-400/80">Creating...</span>
          </div>
        )}
      </div>
      {createError && (
        <div className="text-[10px] font-mono text-red-400 flex items-center justify-between px-1">
          <span>{createError}</span>
          <button type="button" onClick={() => setCreateError(null)} className="hover:text-red-300">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function CharacterChip({
  entity,
  isSelected,
  onToggle,
  onRename,
  onDelete,
  renaming,
  disabled
}: {
  entity: GoogleFlowEntityOption;
  isSelected: boolean;
  onToggle: () => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
  renaming?: boolean;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(entity.displayName || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitEdit = () => {
    const next = editName.trim();
    if (next && next !== entity.displayName) {
      onRename(next);
    } else {
      setEditName(entity.displayName || '');
    }
    setEditing(false);
  };

  return (
    <div className={cn(
      "group flex items-center gap-1.5 h-8 pr-2 rounded border transition-colors",
      isSelected 
        ? "border-cyan-400/50 bg-cyan-950/40" 
        : "border-primary/20 bg-black/60 hover:border-primary/40",
      disabled && !isSelected && "opacity-40 cursor-not-allowed"
    )}>
      <button 
        type="button" 
        onClick={onToggle}
        disabled={disabled}
        className="h-full flex items-center gap-1.5 pl-1"
      >
        <div className="w-6 h-6 rounded overflow-hidden shrink-0 border border-primary/20 flex items-center justify-center bg-black/60">
          {entity.thumbnailUrl ? (
            <img src={entity.thumbnailUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <User className="w-3 h-3 text-primary/20" />
          )}
        </div>
      </button>
      
      {renaming ? (
        <span className="flex items-center gap-1 text-[10px] font-mono text-cyan-400/80 max-w-[100px] truncate">
          <Loader2 className="w-3 h-3 animate-spin shrink-0" />
          <span className="truncate">{editName || entity.displayName || 'Renaming'}</span>
        </span>
      ) : editing ? (
        <input
          ref={inputRef}
          type="text"
          value={editName}
          onChange={e => setEditName(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') {
              setEditName(entity.displayName || '');
              setEditing(false);
            }
          }}
          className="bg-black/60 border border-cyan-400/50 text-[10px] font-mono text-primary/90 w-24 px-1 py-0.5 rounded outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-[10px] font-mono text-primary/70 hover:text-primary max-w-[100px] truncate flex-1 text-left"
          title="Click to rename"
        >
          {entity.displayName || 'Unnamed'}
        </button>
      )}
      
      {isSelected && (
        <button type="button" onClick={onToggle} className="text-cyan-400 shrink-0">
          <Check className="w-3 h-3" />
        </button>
      )}
      
      {!editing && !renaming && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="opacity-0 group-hover:opacity-100 text-red-400/70 hover:text-red-400 shrink-0 transition-opacity ml-1"
          title="Delete character"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
