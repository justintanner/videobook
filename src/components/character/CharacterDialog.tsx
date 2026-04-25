import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Zap, X, User, Shirt as OutfitIcon, RefreshCw, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import {
  OUTFIT_MODEL_OPTIONS,
  OUTFIT_PROVIDERS,
  type OutfitModelKey,
  type OutfitProvider,
} from '@/hooks/useGenerateOutfit';
import { useAnalyzeCharacterImage } from '@/hooks/useAnalyzeCharacterImage';
import type { UseGenerateCharacterResult, CharacterOutcome } from '@/hooks/useGenerateCharacter';
import type { CharacterProfile } from '@/hooks/useCharacterSlots';
import type { UseMcpResult } from 'use-mcp/react';

type ProfileFieldKey =
  | 'name'
  | 'age'
  | 'gender_presentation'
  | 'ethnicity'
  | 'height'
  | 'build'
  | 'face'
  | 'hair'
  | 'eyes'
  | 'skin'
  | 'distinguishing_features'
  | 'wardrobe_style'
  | 'vibe'
  | 'backstory';

interface FieldDef {
  key: ProfileFieldKey;
  label: string;
  required: boolean;
  multiline?: boolean;
  placeholder?: string;
}

const FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', required: false, placeholder: 'optional handle' },
  { key: 'age', label: 'Age', required: true, placeholder: 'mid-30s' },
  { key: 'gender_presentation', label: 'Presentation', required: true, placeholder: 'feminine' },
  { key: 'ethnicity', label: 'Background', required: true, placeholder: 'Mediterranean / Levantine heritage' },
  { key: 'height', label: 'Height', required: true, placeholder: 'average' },
  { key: 'build', label: 'Build', required: true, placeholder: 'lean athletic' },
  { key: 'face', label: 'Face', required: true, multiline: true },
  { key: 'hair', label: 'Hair', required: true, multiline: true },
  { key: 'eyes', label: 'Eyes', required: true, multiline: true },
  { key: 'skin', label: 'Skin', required: true, multiline: true },
  { key: 'distinguishing_features', label: 'Features', required: true, multiline: true },
  { key: 'wardrobe_style', label: 'Wardrobe', required: false, multiline: true },
  { key: 'vibe', label: 'Vibe', required: false, placeholder: 'quiet confidence' },
  { key: 'backstory', label: 'Backstory', required: false, multiline: true },
];

const DEFAULT_MODELS: OutfitModelKey[] = OUTFIT_MODEL_OPTIONS.map((m) => m.key);
const MODEL_LABELS: Record<OutfitModelKey, string> = Object.fromEntries(
  OUTFIT_MODEL_OPTIONS.map((m) => [m.key, m.label]),
) as Record<OutfitModelKey, string>;

interface ImageChoice {
  assetId: string;
  slug: string;
  fullUrl: string;
  thumbUrl: string;
}

function mediaItemToChoice(item: MediaItem): ImageChoice {
  return {
    assetId: item.id,
    slug: item.slug,
    fullUrl: item.filePath || item.thumbnailSrc || '',
    thumbUrl: item.thumbnailSrc || item.filePath || '',
  };
}

function emptyProfile(sourceAssetId: string): CharacterProfile {
  return {
    age: '',
    gender_presentation: '',
    ethnicity: '',
    height: '',
    build: '',
    face: '',
    hair: '',
    eyes: '',
    skin: '',
    distinguishing_features: '',
    source_image_asset_id: sourceAssetId,
  };
}

interface CharacterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageAssets: MediaItem[];
  projectSlug: string | undefined;
  initialSlug: string | null;
  initialProfile?: CharacterProfile | null;
  generate: UseGenerateCharacterResult['generate'];
  submitting: boolean;
  callTool: UseMcpResult['callTool'];
  callState: UseMcpResult['state'];
  onOpenOutfit: (characterSlug: string) => void;
}

export function CharacterDialog({
  open,
  onOpenChange,
  imageAssets,
  projectSlug,
  initialSlug,
  initialProfile,
  generate,
  submitting,
  callTool,
  callState,
  onOpenOutfit,
}: CharacterDialogProps) {
  const shellRef = useRef<HTMLDivElement>(null);

  const source = useMemo<ImageChoice | null>(() => {
    if (!initialSlug) return null;
    const cleaned = initialSlug.replace(/^@/, '');
    const item = imageAssets.find((m) => m.id === cleaned || m.slug === `@${cleaned}` || m.slug === initialSlug);
    return item ? mediaItemToChoice(item) : null;
  }, [initialSlug, imageAssets]);

  const [profile, setProfile] = useState<CharacterProfile | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Set<OutfitModelKey>>(new Set(DEFAULT_MODELS));
  const [selectedProvider, setSelectedProvider] = useState<OutfitProvider>('kie');
  const [lastOutcomes, setLastOutcomes] = useState<CharacterOutcome[]>([]);
  const [outfitText, setOutfitText] = useState<string>('');
  const [outfitImageSlug, setOutfitImageSlug] = useState<string | null>(null);

  const garmentChoices = useMemo<ImageChoice[]>(
    () => imageAssets.filter((m) => m.type === 'image').map(mediaItemToChoice),
    [imageAssets],
  );
  const outfitImage = useMemo<ImageChoice | null>(() => {
    if (!outfitImageSlug) return null;
    return garmentChoices.find((c) => c.assetId === outfitImageSlug) ?? null;
  }, [outfitImageSlug, garmentChoices]);

  const { analyze, loading: analyzing } = useAnalyzeCharacterImage(callTool);
  const lastAnalyzedRef = useRef<string | null>(null);

  // When the dialog opens with a source, either seed from a supplied profile
  // (re-edit mode) or run vision extraction (new char-* from img-*).
  useEffect(() => {
    if (!open || !source || !projectSlug || callState !== 'ready') return;
    if (lastAnalyzedRef.current === source.assetId) return;
    lastAnalyzedRef.current = source.assetId;
    void (async () => {
      setAnalyzeError(null);
      setLastOutcomes([]);
      if (initialProfile) {
        setProfile(initialProfile);
        return;
      }
      const extracted = await analyze(projectSlug, source.assetId);
      if (extracted) {
        setProfile(extracted);
      } else {
        setProfile(emptyProfile(source.assetId));
        setAnalyzeError('Vision extraction failed. Fill the fields manually and click Generate.');
      }
    })();
  }, [open, source, projectSlug, callState, analyze, initialProfile]);

  const setProfileField = useCallback((key: ProfileFieldKey, value: string) => {
    setProfile((prev) => {
      const base = prev ?? emptyProfile(source?.assetId ?? '');
      return { ...base, [key]: value };
    });
  }, [source]);

  const profileComplete = useMemo(() => {
    if (!profile) return false;
    return FIELDS.filter((f) => f.required).every((f) => {
      const v = profile[f.key];
      return typeof v === 'string' && v.trim().length > 0;
    });
  }, [profile]);

  const canSubmit = !submitting && !analyzing && !!projectSlug && !!source && !!profile && profileComplete && selectedModels.size > 0;

  const handleGenerate = useCallback(async () => {
    if (!canSubmit || !projectSlug || !source || !profile) return;
    const res = await generate({
      projectSlug,
      sourceImageSlug: source.assetId,
      profile,
      models: [...selectedModels],
      provider: selectedProvider,
      outfitText: outfitText.trim() ? outfitText.trim() : undefined,
      outfitImageSlug: outfitImageSlug ?? undefined,
    });
    if (res) setLastOutcomes(res.outcomes);
  }, [canSubmit, projectSlug, source, profile, selectedModels, selectedProvider, generate, outfitText, outfitImageSlug]);

  const successOutcomes = useMemo(
    () => lastOutcomes.filter((o) => !!o.char_asset_id && !o.error),
    [lastOutcomes],
  );

  const previewCharSlug = successOutcomes[0]?.char_asset_id ?? null;
  const previewItem = useMemo(() => {
    if (!previewCharSlug) return null;
    return imageAssets.find((m) => m.id === previewCharSlug) ?? null;
  }, [previewCharSlug, imageAssets]);

  const handleOpenOutfit = useCallback(() => {
    if (!previewCharSlug) return;
    onOpenChange(false);
    onOpenOutfit(`@${previewCharSlug}`);
  }, [previewCharSlug, onOpenChange, onOpenOutfit]);

  const toggleModel = useCallback((m: OutfitModelKey) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  }, []);

  if (!open) return null;

  return (
    <div
      ref={shellRef}
      role="dialog"
      aria-label="Character generation"
      className="fixed inset-0 z-[101] bg-zinc-950 flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-violet-300/80 uppercase">
          <User className="w-3.5 h-3.5" />
          Character — Identity profile + 4-up reference sheet
        </div>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onOpenChange(false)}
          aria-label="Close character view"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body — two columns */}
      <div className="flex-1 min-h-0 overflow-hidden flex">
        {/* Left: source + form */}
        <div className="w-[420px] shrink-0 border-r border-border/50 overflow-y-auto px-4 py-4 space-y-4">
          <section>
            <div className="text-[10px] font-mono uppercase tracking-wider text-violet-300/70 mb-1.5">Source</div>
            {source ? (
              <div className="flex gap-2 items-center">
                <div className="w-24 h-24 rounded border border-violet-500/30 overflow-hidden bg-black shrink-0">
                  <img src={source.thumbUrl} alt={source.slug} className="w-full h-full object-cover" />
                </div>
                <div className="text-[11px] font-mono text-violet-100 truncate" title={source.slug}>
                  {source.slug}
                </div>
              </div>
            ) : (
              <div className="text-[11px] font-mono text-muted-foreground">No source image selected. Run /character @img-… to seed one.</div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-violet-300/70">Profile</div>
              {analyzing && <Loader2 className="w-3 h-3 animate-spin text-violet-300" />}
            </div>
            {analyzeError && (
              <div className="text-[10px] font-mono text-amber-400/80 mb-2">{analyzeError}</div>
            )}
            <div className="space-y-2">
              {FIELDS.map((f) => {
                const value = profile?.[f.key] ?? '';
                const Tag = f.multiline ? 'textarea' : 'input';
                return (
                  <label key={f.key} className="block">
                    <div className="text-[9px] font-mono uppercase tracking-wider text-violet-400/60 mb-0.5">
                      {f.label}{f.required ? ' *' : ''}
                    </div>
                    <Tag
                      value={typeof value === 'string' ? value : ''}
                      placeholder={f.placeholder ?? ''}
                      disabled={analyzing}
                      onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                        setProfileField(f.key, e.target.value)
                      }
                      className={cn(
                        'w-full bg-black/40 border border-violet-500/20 rounded px-2 py-1.5 text-[11px] font-mono text-violet-100',
                        'focus:border-violet-400/60 focus:outline-none focus:ring-1 focus:ring-violet-400/40',
                        f.multiline ? 'min-h-[44px] resize-y' : '',
                      )}
                      rows={f.multiline ? 2 : undefined}
                    />
                  </label>
                );
              })}
            </div>
          </section>
        </div>

        {/* Right: preview + controls */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-hidden flex items-center justify-center bg-black/30 p-6">
            {previewItem?.filePath ? (
              <img
                src={previewItem.filePath}
                alt={previewItem.title}
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
            ) : submitting ? (
              <div className="flex flex-col items-center gap-2 text-violet-300/70 text-xs font-mono">
                <Loader2 className="w-6 h-6 animate-spin" />
                Generating character sheet…
              </div>
            ) : lastOutcomes.length > 0 ? (
              <div className="flex flex-col items-center gap-1 text-violet-300/70 text-xs font-mono">
                <Sparkles className="w-5 h-5" />
                Sheet enqueued — waiting for first model to finish
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground text-xs font-mono text-center max-w-md">
                <Sparkles className="w-6 h-6 opacity-60" />
                Edit the profile on the left, pick one or more models below, then click Generate.
                <div className="text-[10px] opacity-70">Output: 2x2 reference sheet — face profile, face front, body front, body back.</div>
              </div>
            )}
          </div>

          {/* Per-model outcome strip */}
          {successOutcomes.length > 1 && (
            <div className="border-t border-border/50 px-4 py-2 flex gap-2 overflow-x-auto bg-black/20">
              {successOutcomes.map((o) => {
                const item = imageAssets.find((m) => m.id === o.char_asset_id);
                if (!item) return null;
                return (
                  <button
                    key={o.char_asset_id}
                    type="button"
                    title={`${MODEL_LABELS[o.model]} — ${o.char_asset_id}`}
                    className={cn(
                      'shrink-0 w-16 h-16 rounded border overflow-hidden bg-black',
                      o.char_asset_id === previewCharSlug ? 'border-violet-300' : 'border-violet-500/20 hover:border-violet-400/50',
                    )}
                    onClick={() => setLastOutcomes((prev) => {
                      const idx = prev.findIndex((p) => p.char_asset_id === o.char_asset_id);
                      if (idx <= 0) return prev;
                      const reordered = [prev[idx], ...prev.filter((_, i) => i !== idx)];
                      return reordered;
                    })}
                  >
                    {item.thumbnailSrc || item.filePath ? (
                      <img src={item.thumbnailSrc ?? item.filePath} alt={item.title} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[9px] font-mono text-violet-400/50">
                        {MODEL_LABELS[o.model].split(' ')[0]}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Controls */}
          <div className="border-t border-border/50 px-4 py-3 space-y-3 bg-black/40">
            <section>
              <div className="text-[10px] font-mono uppercase tracking-wider text-violet-300/70 mb-1.5">
                Sheet outfit (optional override)
              </div>
              <div className="flex gap-2 items-start">
                <input
                  type="text"
                  value={outfitText}
                  placeholder="e.g. plain white t-shirt and dark jeans"
                  onChange={(e) => setOutfitText(e.target.value)}
                  className={cn(
                    'flex-1 bg-black/40 border border-violet-500/20 rounded px-2 py-1.5 text-[11px] font-mono text-violet-100',
                    'focus:border-violet-400/60 focus:outline-none focus:ring-1 focus:ring-violet-400/40',
                  )}
                />
                {outfitImage ? (
                  <div className="relative w-12 h-12 rounded border border-violet-500/40 overflow-hidden bg-black shrink-0">
                    <img src={outfitImage.thumbUrl} alt={outfitImage.slug} className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => setOutfitImageSlug(null)}
                      aria-label="Remove garment reference"
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-900 border border-violet-400/40 text-violet-200 hover:bg-red-500/40 hover:border-red-400 flex items-center justify-center"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1 mt-1.5 max-h-20 overflow-y-auto">
                {garmentChoices.slice(0, 24).map((g) => (
                  <button
                    key={g.assetId}
                    type="button"
                    onClick={() => setOutfitImageSlug(g.assetId === outfitImageSlug ? null : g.assetId)}
                    title={g.slug}
                    className={cn(
                      'shrink-0 w-9 h-9 rounded border overflow-hidden bg-black transition-colors',
                      g.assetId === outfitImageSlug
                        ? 'border-violet-300'
                        : 'border-violet-500/20 hover:border-violet-400/60',
                    )}
                  >
                    <img src={g.thumbUrl} alt={g.slug} className="w-full h-full object-cover" />
                  </button>
                ))}
                {garmentChoices.length === 0 && (
                  <div className="text-[9px] font-mono text-violet-400/50">No image assets in this project yet.</div>
                )}
              </div>
            </section>

            <section>
              <div className="text-[10px] font-mono uppercase tracking-wider text-violet-300/70 mb-1.5">Models</div>
              <div className="flex flex-wrap gap-1.5">
                {OUTFIT_MODEL_OPTIONS.map((m) => {
                  const active = selectedModels.has(m.key);
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => toggleModel(m.key)}
                      className={cn(
                        'px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        active
                          ? 'border-violet-300 bg-violet-500/15 text-violet-100'
                          : 'border-violet-500/20 text-violet-300/60 hover:border-violet-400/50',
                      )}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <div className="text-[10px] font-mono uppercase tracking-wider text-violet-300/70 mb-1.5">Provider</div>
              <div className="flex gap-1.5">
                {OUTFIT_PROVIDERS.map((p) => {
                  const active = selectedProvider === p.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setSelectedProvider(p.key)}
                      className={cn(
                        'px-3 py-1 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        active
                          ? 'border-violet-300 bg-violet-500/15 text-violet-100'
                          : 'border-violet-500/20 text-violet-300/60 hover:border-violet-400/50',
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!canSubmit}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded text-xs font-mono uppercase tracking-wider transition-colors',
                  canSubmit
                    ? 'bg-violet-500/20 border border-violet-300 text-violet-100 hover:bg-violet-500/30'
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-500 cursor-not-allowed',
                )}
              >
                {submitting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : lastOutcomes.length > 0 ? (
                  <RefreshCw className="w-3.5 h-3.5" />
                ) : (
                  <Zap className="w-3.5 h-3.5" />
                )}
                {lastOutcomes.length > 0 ? 'Regenerate' : 'Generate'}
              </button>
              <button
                type="button"
                onClick={handleOpenOutfit}
                disabled={!previewCharSlug}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded text-xs font-mono uppercase tracking-wider transition-colors',
                  previewCharSlug
                    ? 'bg-purple-500/20 border border-purple-300 text-purple-100 hover:bg-purple-500/30'
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-500 cursor-not-allowed',
                )}
                title={previewCharSlug ? 'Open the outfit composer with this character pre-filled' : 'Generate a character first'}
              >
                <OutfitIcon className="w-3.5 h-3.5" />
                Open Outfit
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
