import { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, Loader2, Plus, RefreshCw, Trash2, Edit2, AlertTriangle, Copy, User, Image as ImageIcon, CheckCircle2 } from 'lucide-react';
import type { UseMcpResult } from 'use-mcp/react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import { useMountKey } from '@/contexts/MountKeyContext';
import { CloseButton } from '@/components/ui/CloseButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ViewerToolbar } from './viewer-shared';
import { useGoogleFlowEntities } from '@/hooks/useGoogleFlowEntities';
import type { MediaItem } from '@/components/sidebar/types';

type TextContent = Array<{ type: string; text: string }>;

type DetailResponse = {
  ref: string;
  display_name: string;
  thumbnail_url: string | null;
  image_count: number;
    raw?: {
      personalityNotes?: string;
      voice?: Record<string, string>;
      _conflict?: string;
    };
};

type FormState = {
  ref?: string;
  displayName: string;
  imageSlugs: string[];
  personalityNotes: string;
  voice: string;
};

export function GoogleFlowCharactersScreen({
  bookId,
  callTool,
  callState,
  mediaItems = [],
  onClose,
}: {
  bookId: string;
  callTool: UseMcpResult['callTool'];
  callState: UseMcpResult['state'];
  mediaItems?: MediaItem[];
  onClose: () => void;
}) {
  useMountKey('viewer');

  const {
    entities: characters,
    loading: charsLoading,
    error: charsError,
    refresh: refreshChars,
    ensureLoaded: ensureCharsLoaded,
  } = useGoogleFlowEntities('character', callTool, callState);

  const {
    entities: voices,
    ensureLoaded: ensureVoicesLoaded,
  } = useGoogleFlowEntities('voice', callTool, callState);

  useEffect(() => {
    ensureCharsLoaded();
    ensureVoicesLoaded();
  }, [ensureCharsLoaded, ensureVoicesLoaded]);

  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  
  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list');
  const [form, setForm] = useState<FormState>({ displayName: '', imageSlugs: [], personalityNotes: '', voice: '' });
  const [submitting, setSubmitting] = useState(false);
  const [deleteConfirmRef, setDeleteConfirmRef] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchDetail = useCallback(async (ref: string) => {
    if (callState !== 'ready') return;
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await callTool('get_google_flow_character', { ref });
      if (res.isError) {
        toast({ title: 'Fetch failed', description: (res.content as TextContent)?.[0]?.text ?? 'Failed to load details' });
        return;
      }
      const data = JSON.parse((res.content as TextContent)[0].text) as DetailResponse;
      setDetail(data);
    } catch (e) {
      toast({ title: 'Fetch failed', description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setDetailLoading(false);
    }
  }, [callTool, callState]);

  const handleSelect = useCallback((ref: string) => {
    setSelectedRef(ref);
    setMode('list');
    setDeleteConfirmRef(null);
    fetchDetail(ref);
  }, [fetchDetail]);

  const handleCreateNew = useCallback(() => {
    setSelectedRef(null);
    setDetail(null);
    setForm({ displayName: '', imageSlugs: [], personalityNotes: '', voice: '' });
    setMode('create');
  }, []);

  const handleEdit = useCallback(() => {
    if (!detail) return;
    const voiceRef = typeof detail.raw?.voice === 'object' ? Object.values(detail.raw.voice)[0] : '';
    setForm({
      displayName: detail.display_name,
      imageSlugs: [], // empty means keep existing upstream images
      personalityNotes: typeof detail.raw?.personalityNotes === 'string' ? detail.raw.personalityNotes : '',
      voice: voiceRef ?? '',
    });
    setMode('edit');
  }, [detail]);

  const imageAssets = useMemo(() => 
    mediaItems.filter(m => (m.type === 'image' || m.type === 'character') && (m.status ?? 'ready') === 'ready')
  , [mediaItems]);

  const handleFormSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (callState !== 'ready' || !bookId) return;
    setSubmitting(true);
    try {
      if (mode === 'create') {
        const res = await callTool('create_google_flow_character', {
          book_id: bookId,
          display_name: form.displayName,
          image_slugs: form.imageSlugs,
          ...(form.personalityNotes.trim() ? { personality_notes: form.personalityNotes } : {}),
          ...(form.voice ? { voice: form.voice } : {}),
        });
        if (res.isError) {
          toast({ title: 'Create failed', description: (res.content as TextContent)?.[0]?.text ?? 'Failed to create' });
          return;
        }
        const data = JSON.parse((res.content as TextContent)[0].text);
        if (data.status === 'partial-success' || data.warning) {
          toast({ title: 'Created with warning', description: data.warning || 'Provider sync issue detected', duration: 8000 });
        } else {
          toast({ title: 'Character created', description: form.displayName });
        }
        await refreshChars();
        if (data.character_ref) {
          handleSelect(data.character_ref);
        } else {
          setMode('list');
        }
      } else if (mode === 'edit' && detail) {
        const res = await callTool('replace_google_flow_character', {
          ref: detail.ref,
          book_id: bookId,
          display_name: form.displayName,
          ...(form.imageSlugs.length > 0 ? { image_slugs: form.imageSlugs } : {}),
          personality_notes: form.personalityNotes,
          clear_personality_notes: !form.personalityNotes.trim(),
          voice: form.voice,
          clear_voice: !form.voice,
        });
        if (res.isError) {
          toast({ title: 'Replace failed', description: (res.content as TextContent)?.[0]?.text ?? 'Failed to replace' });
          return;
        }
        const data = JSON.parse((res.content as TextContent)[0].text);
        if (data.warning) {
          toast({ title: 'Warning', description: data.warning, duration: 6000 });
        } else {
          toast({ title: 'Character updated', description: form.displayName });
        }
        await refreshChars();
        if (data.character_ref) {
          handleSelect(data.character_ref);
        } else {
          setMode('list');
        }
      }
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }, [callState, bookId, mode, form, detail, callTool, refreshChars, handleSelect]);

  const handleDelete = useCallback(async (ref: string) => {
    if (callState !== 'ready') return;
    setDeleting(true);
    try {
      const res = await callTool('delete_google_flow_character', { ref });
      if (res.isError) {
        toast({ title: 'Delete failed', description: (res.content as TextContent)?.[0]?.text ?? 'Failed to delete' });
        return;
      }
      toast({ title: 'Character deleted' });
      setSelectedRef(null);
      setDetail(null);
      setMode('list');
      refreshChars();
    } catch (e) {
      toast({ title: 'Delete failed', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setDeleting(false);
      setDeleteConfirmRef(null);
    }
  }, [callState, callTool, refreshChars]);

  const copyRef = useCallback((ref: string) => {
    navigator.clipboard.writeText(ref);
    toast({ title: 'Copied ref', description: ref });
  }, []);

  const toggleImageSlug = useCallback((slug: string) => {
    setForm(f => {
      const next = new Set(f.imageSlugs);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        if (next.size >= 2) return f; // max 2
        next.add(slug);
      }
      return { ...f, imageSlugs: Array.from(next) };
    });
  }, []);

  return (
    <div className="flex-1 min-w-0 flex items-center justify-center overflow-hidden">
 <div className="size-full min-w-0 relative bg-zinc-950">
        <div className="absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
          <ViewerToolbar
            left={
              <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-cyan-300/90 drop-shadow-[0_0_4px_rgba(45,212,191,0.5)]">
 <Users className="size-3.5" />
                <span>GOOGLE FLOW CHARACTERS</span>
              </span>
            }
            slug="Manager"
            right={<CloseButton tone="cyan" onClick={onClose} />}
          />

          <div className="flex-1 min-h-0 flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-zinc-800">
            {/* LEFT PANE: LIST */}
            <div className="w-full md:w-1/3 max-w-sm flex flex-col min-h-[200px]">
              <div className="p-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/30">
                <h3 className="text-xs font-mono font-semibold text-zinc-400">ACCOUNT ENTITIES</h3>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => refreshChars()}
                    disabled={charsLoading}
                    className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-50"
                  >
 <RefreshCw className={cn("size-4 ", charsLoading && "animate-spin")} />
                  </button>
                  <button
                    onClick={handleCreateNew}
                    className="p-1.5 rounded text-cyan-400 hover:text-cyan-300 hover:bg-cyan-400/10 transition-colors ml-1"
                    title="Create new character"
                  >
 <Plus className="size-4" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
                {charsError && (
                  <div className="p-3 text-sm text-red-400 bg-red-950/30 rounded font-mono border border-red-900/50">
                    {charsError}
                  </div>
                )}
                {!charsError && charsLoading && characters.length === 0 && (
                  <div className="flex items-center justify-center p-8 text-zinc-500">
 <Loader2 className="size-5 animate-spin" />
                  </div>
                )}
                {!charsError && !charsLoading && characters.length === 0 && (
                  <EmptyState size="sm">No characters found.</EmptyState>
                )}
                {characters.map(char => (
                  <button
                    key={char.ref}
                    onClick={() => handleSelect(char.ref)}
                    className={cn(
                      "w-full text-left p-2 rounded flex items-center gap-3 transition-colors",
                      selectedRef === char.ref ? "bg-cyan-950/40 border border-cyan-900/50" : "hover:bg-zinc-800/50 border border-transparent"
                    )}
                  >
 <div className="size-10 rounded overflow-hidden bg-zinc-800 shrink-0 border border-zinc-700/50 flex items-center justify-center">
                      {char.thumbnailUrl ? (
 <img src={char.thumbnailUrl} alt={char.displayName} className="size-full object-cover" />
                      ) : (
 <User className="size-5 text-zinc-600" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={cn("text-sm font-semibold min-w-0 truncate", selectedRef === char.ref ? "text-cyan-300" : "text-zinc-200")}>
                        {char.displayName}
                      </div>
                      <div className="text-[10px] font-mono text-zinc-500 min-w-0 truncate mt-0.5 opacity-80" title={char.ref}>
                        {char.ref}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* RIGHT PANE: DETAIL / FORM */}
            <div className="flex-1 min-w-0 flex flex-col bg-zinc-950/50 overflow-y-auto relative">
              {mode === 'list' && selectedRef && (
                <div className="p-6">
                  {detailLoading ? (
                    <div className="flex flex-col items-center justify-center h-64 text-zinc-500 gap-3">
 <Loader2 className="size-6 animate-spin" />
                      <span className="font-mono text-xs">Loading detail...</span>
                    </div>
                  ) : detail ? (
                    <div className="max-w-2xl mx-auto flex flex-col gap-6">
                      <div className="flex items-start justify-between">
                        <div className="flex gap-4 items-center">
 <div className="size-20 shrink-0 rounded overflow-hidden bg-zinc-800 border border-zinc-700">
                            {detail.thumbnail_url ? (
 <img src={detail.thumbnail_url} alt={detail.display_name} className="size-full object-cover" />
                            ) : (
 <div className="size-full flex items-center justify-center"><User className="size-8 text-zinc-600" /></div>
                            )}
                          </div>
                          <div>
                            <h2 className="text-xl font-bold text-white">{detail.display_name}</h2>
                            <button onClick={() => copyRef(detail.ref)} className="mt-1 flex items-center gap-1.5 text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors">
                              <span className="min-w-0 truncate max-w-[300px]">{detail.ref}</span>
 <Copy className="size-3 shrink-0" />
                            </button>
                          </div>
                        </div>
                        <div className="flex gap-2 min-w-fit">
                          <button onClick={handleEdit} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-xs font-mono font-semibold transition-colors flex items-center gap-1.5">
 <Edit2 className="size-3.5" /> Edit
                          </button>
                          {deleteConfirmRef === detail.ref ? (
                            <div className="flex items-center gap-1 bg-red-950/40 border border-red-900/50 rounded px-1 py-1">
                              <button
                                onClick={() => handleDelete(detail.ref)}
                                disabled={deleting}
                                className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-mono font-semibold transition-colors"
                              >
                                {deleting ? '...' : 'Confirm'}
                              </button>
                              <button
                                onClick={() => setDeleteConfirmRef(null)}
                                disabled={deleting}
                                className="px-3 py-1 bg-transparent hover:bg-zinc-800 text-zinc-300 rounded text-xs font-mono transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button onClick={() => setDeleteConfirmRef(detail.ref)} className="px-3 py-1.5 bg-transparent hover:bg-red-900/30 text-zinc-400 hover:text-red-400 rounded text-xs font-mono font-semibold transition-colors flex items-center gap-1.5 border border-transparent hover:border-red-900/50">
 <Trash2 className="size-3.5" /> Delete
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-col gap-4">
                        {detail.raw?._conflict === 'singleton-read-disagrees' && (
                          <div className="bg-amber-950/30 border border-amber-900/50 rounded p-3 flex items-start gap-3">
 <AlertTriangle className="size-5 text-amber-500 shrink-0 mt-0.5" />
                            <div className="text-sm text-amber-200/90 leading-relaxed flex flex-col gap-1">
                              <strong className="text-amber-400 block">Upstream Sync Conflict</strong>
                              <span>The upstream provider's detail record lost the name or notes (read disagreement). The intended metadata has been preserved from the list model.</span>
                            </div>
                          </div>
                        )}
                        <div className="bg-zinc-900/50 border border-zinc-800 rounded p-4 flex flex-col gap-1">
                          <h4 className="text-xs font-mono text-zinc-500">PERSONALITY NOTES</h4>
                          <p className="text-sm text-zinc-300 whitespace-pre-wrap">{detail.raw?.personalityNotes || <span className="italic text-zinc-600">None</span>}</p>
                        </div>
                        <div className="bg-zinc-900/50 border border-zinc-800 rounded p-4 flex items-center justify-between">
                          <div className="flex flex-col gap-1">
                            <h4 className="text-xs font-mono text-zinc-500">VOICE</h4>
                            <p className="text-sm text-zinc-300 font-mono">
                              {typeof detail.raw?.voice === 'object' ? Object.values(detail.raw.voice)[0] : <span className="italic text-zinc-600">None</span>}
                            </p>
                          </div>
                          <div className="flex flex-col gap-1">
                            <h4 className="text-xs font-mono text-zinc-500 text-right">SOURCE IMAGES</h4>
                            <p className="text-sm text-zinc-300 text-right">{detail.image_count}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <EmptyState size="sm">Failed to load details</EmptyState>
                  )}
                </div>
              )}

              {(mode === 'create' || mode === 'edit') && (
                <div className="p-6 max-w-2xl mx-auto w-full">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
 {mode === 'create' ? <Plus className="size-5 text-cyan-400" /> : <Edit2 className="size-5 text-cyan-400" />}
                      {mode === 'create' ? 'Create Character' : 'Replace Character'}
                    </h2>
                    <button onClick={() => setMode('list')} className="text-xs font-mono text-zinc-400 hover:text-white transition-colors">
                      Cancel
                    </button>
                  </div>

                  {mode === 'edit' && (
                    <div className="mb-6 bg-amber-950/30 border border-amber-900/50 rounded p-3 flex items-start gap-3">
 <AlertTriangle className="size-5 text-amber-500 shrink-0 mt-0.5" />
                      <div className="text-sm text-amber-200/90 leading-relaxed flex flex-col gap-1">
                        <strong className="text-amber-400 block">Destructive Replacement</strong>
                        <span>Google Flow does not support native updates. This operation will create a <strong>new character</strong> and attempt to delete the old one. The character ref will change.</span>
                      </div>
                    </div>
                  )}

                  <form onSubmit={handleFormSubmit} className="flex flex-col gap-6">
                    <div className="flex flex-col gap-2">
                      <label className="block text-xs font-mono text-zinc-400">DISPLAY NAME (Required)</label>
                      <input
                        type="text"
                        required
                        maxLength={200}
                        value={form.displayName}
                        onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all"
                        placeholder="e.g. Astronaut hero"
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="block text-xs font-mono text-zinc-400">
                        SOURCE IMAGES {mode === 'create' ? '(1-2 Required)' : '(Optional - select to replace existing)'}
                      </label>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-48 overflow-y-auto p-2 bg-zinc-900/50 border border-zinc-800 rounded scrollbar-domain">
                        {imageAssets.map(asset => {
                          const slug = `@${asset.id}`;
                          const isSelected = form.imageSlugs.includes(slug);
                          const disabled = !isSelected && form.imageSlugs.length >= 2;
                          return (
                            <button
                              key={asset.id}
                              type="button"
                              onClick={() => toggleImageSlug(slug)}
                              disabled={disabled}
                              className={cn(
                                "relative aspect-square rounded overflow-hidden border-2 transition-all group",
                                isSelected ? "border-cyan-500 ring-2 ring-cyan-500/30" : "border-zinc-800 hover:border-zinc-600",
                                disabled && "opacity-30 cursor-not-allowed"
                              )}
                            >
                              {asset.thumbnailSrc || asset.filePath ? (
 <img src={asset.thumbnailSrc || asset.filePath} alt={asset.title} className="size-full object-cover" />
                              ) : (
 <div className="size-full flex flex-col items-center justify-center gap-1 bg-zinc-800 text-zinc-500">
 <ImageIcon className="size-6" />
                                  <span className="text-[10px] font-mono px-1 min-w-0 truncate w-full text-center">{asset.title}</span>
                                </div>
                              )}
                              {isSelected && (
                                <div className="absolute top-1 right-1 bg-cyan-500 rounded-full p-0.5">
 <CheckCircle2 className="size-3 text-white" />
                                </div>
                              )}
                              <div className="absolute bottom-0 inset-x-0 bg-black/60 p-1">
                                <p className="text-[9px] font-mono text-white min-w-0 truncate text-center">{asset.id}</p>
                              </div>
                            </button>
                          );
                        })}
                        {imageAssets.length === 0 && (
                          <div className="col-span-full py-8 text-center text-zinc-500 text-xs font-mono">
                            No valid images or characters found in project.
                          </div>
                        )}
                      </div>
                      <p className="text-[10px] font-mono text-zinc-500">
                        {form.imageSlugs.length}/2 selected. {mode === 'edit' && 'Leave empty to preserve existing upstream images.'}
                      </p>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="block text-xs font-mono text-zinc-400">PERSONALITY NOTES (Optional)</label>
                      <textarea
                        maxLength={2000}
                        rows={3}
                        value={form.personalityNotes}
                        onChange={e => setForm(f => ({ ...f, personalityNotes: e.target.value }))}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all resize-y"
                        placeholder="e.g. Grumpy but fiercely loyal."
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="block text-xs font-mono text-zinc-400">VOICE (Optional)</label>
                      <select
                        value={form.voice}
                        onChange={e => setForm(f => ({ ...f, voice: e.target.value }))}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all appearance-none"
                      >
                        <option value="">-- None (Clear Voice) --</option>
                        {voices.map(v => (
                          <option key={v.ref} value={v.ref}>
                            {v.displayName} {v.source === 'user' ? '(Custom)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="pt-4 flex justify-end">
                      <button
                        type="submit"
                        disabled={submitting || (mode === 'create' && (!form.displayName.trim() || form.imageSlugs.length === 0))}
                        className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold font-mono text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
 {submitting && <Loader2 className="size-4 animate-spin" />}
                        {mode === 'create' ? 'Create Character' : 'Apply Replace'}
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
