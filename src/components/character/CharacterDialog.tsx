import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Zap, X, User, RefreshCw } from 'lucide-react';
import { CloseButton } from '@/components/ui/CloseButton';
import { EmptyState } from '@/components/ui/EmptyState';
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
import { type CharacterProfile, type CharacterSubjectKind, isFreeformSubject } from '@/hooks/useCharacterSlots';
import { useElevenLabsVoices } from '@/hooks/useElevenLabsVoices';
import { useEstimateCost, type EstimateCall } from '@/hooks/useEstimateCost';
import { CostBadge } from '@/components/cost/CostBadge';
import type { UseMcpResult } from 'use-mcp/react';
import { toast } from '@/hooks/useToast';

const FAL_OUTFIT_ENDPOINT_BY_MODEL: Record<OutfitModelKey, string> = {
  nano_banana_pro: 'fal-ai/nano-banana-pro/edit',
  qwen_image_edit: 'fal-ai/qwen-image/edit',
  gpt_image_2: 'fal-ai/nano-banana-pro/edit',
  wan27_pro: 'fal-ai/wan/v2.7/pro/edit',
  seedream_v5_lite: 'fal-ai/bytedance/seedream/v5/lite/edit',
};

const FAL_OUTFIT_TOOL_BY_MODEL: Record<OutfitModelKey, string> = {
  nano_banana_pro: 'generate_nano_banana_pro_edit_fal',
  qwen_image_edit: 'generate_qwen_image_edit_fal',
  gpt_image_2: 'generate_nano_banana_pro_edit_fal',
  wan27_pro: 'generate_wan27_pro_edit_fal',
  seedream_v5_lite: 'generate_seedream_v5_lite_edit_fal',
};

type ProfileFieldKey =
  | 'name'
  | 'age'
  | 'ethnicity'
  | 'height'
  | 'build'
  | 'bust'
  | 'waist'
  | 'hips'
  | 'face'
  | 'hair'
  | 'eyes'
  | 'skin'
  | 'other';

interface FieldDef {
  key: ProfileFieldKey;
  label: string;
  required: boolean;
  multiline?: boolean;
  placeholder?: string;
}

interface FieldGroup {
  title: string;
  fields: ProfileFieldKey[];
}

const SUBJECT_KINDS: ReadonlyArray<CharacterSubjectKind> = ['female', 'male', 'animal', 'other'];

const HUMAN_GROUPS: FieldGroup[] = [
  { title: 'Identity', fields: ['name', 'age', 'ethnicity'] },
  { title: 'Body', fields: ['height', 'build', 'bust', 'waist', 'hips'] },
  { title: 'Face + Surface', fields: ['face', 'hair', 'eyes', 'skin'] },
];

const FREEFORM_GROUPS: FieldGroup[] = [
  { title: 'Identity', fields: ['name', 'other'] },
];

const FIELDS: Record<ProfileFieldKey, FieldDef> = {
  name: { key: 'name', label: 'Name', required: false, placeholder: 'optional handle' },
  age: { key: 'age', label: 'Age', required: true, placeholder: 'mid-30s' },
  ethnicity: { key: 'ethnicity', label: 'Background', required: true, placeholder: 'Mediterranean / Levantine heritage' },
  height: { key: 'height', label: 'Height', required: true, placeholder: 'average' },
  build: { key: 'build', label: 'Build', required: true, placeholder: 'lean athletic' },
  bust: { key: 'bust', label: 'Chest', required: true, placeholder: 'broad chest or small B-cup' },
  waist: { key: 'waist', label: 'Waist', required: true, placeholder: 'narrow ~26", sharp taper' },
  hips: { key: 'hips', label: 'Hips', required: true, placeholder: 'rounded ~36", curved outer thigh' },
  face: { key: 'face', label: 'Face', required: true, multiline: true },
  hair: { key: 'hair', label: 'Hair', required: true, multiline: true },
  eyes: { key: 'eyes', label: 'Eyes', required: true, multiline: true },
  skin: { key: 'skin', label: 'Skin', required: true, multiline: true },
  other: {
    key: 'other',
    label: 'Other',
    required: true,
    multiline: true,
    placeholder: "e.g. 'white domestic longhair cat, fluffy white coat, heterochromatic eyes' or 'origami paper man, folded white cardstock, sharp creases, blank face'",
  },
};

const DEFAULT_MODELS: OutfitModelKey[] = OUTFIT_MODEL_OPTIONS.map((m) => m.key);
const MAX_ADDITIONAL_REFERENCES = 2;

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

function fieldGroups(subjectKind: CharacterSubjectKind): FieldGroup[] {
  return isFreeformSubject(subjectKind) ? FREEFORM_GROUPS : HUMAN_GROUPS;
}

function fieldDef(key: ProfileFieldKey): FieldDef {
  return FIELDS[key];
}

function requiredFields(subjectKind: CharacterSubjectKind): ProfileFieldKey[] {
  return fieldGroups(subjectKind)
    .flatMap((group) => group.fields)
    .filter((key) => FIELDS[key].required);
}

function emptyProfile(sourceAssetId: string): CharacterProfile {
  return {
    subject_kind: 'female',
    source_image_asset_id: sourceAssetId,
  };
}

function profileWithVoiceId(base: CharacterProfile | null, sourceAssetId: string, voiceId: string): CharacterProfile {
  const next = { ...(base ?? emptyProfile(sourceAssetId)) };
  const trimmed = voiceId.trim();
  if (trimmed) next.elevenlabs_voice_id = trimmed;
  else delete next.elevenlabs_voice_id;
  return next;
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
  onProfileSaved?: (profile: CharacterProfile) => void;
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
  onProfileSaved,
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
  const [additionalReferenceSlugs, setAdditionalReferenceSlugs] = useState<string[]>([]);
  const [outfitText, setOutfitText] = useState<string>('');
  const [outfitImageSlug, setOutfitImageSlug] = useState<string | null>(null);
  const [voiceSaving, setVoiceSaving] = useState(false);

  const imageChoices = useMemo<ImageChoice[]>(
    () => imageAssets.filter((m) => m.type === 'image').map(mediaItemToChoice),
    [imageAssets],
  );
  const additionalReferenceChoices = useMemo<ImageChoice[]>(
    () => imageChoices.filter((c) => c.assetId !== source?.assetId && c.assetId !== outfitImageSlug),
    [imageChoices, source, outfitImageSlug],
  );
  const garmentChoices = useMemo<ImageChoice[]>(
    () => imageChoices.filter((c) => c.assetId !== source?.assetId && !additionalReferenceSlugs.includes(c.assetId)),
    [imageChoices, source, additionalReferenceSlugs],
  );
  const outfitImage = useMemo<ImageChoice | null>(() => {
    if (!outfitImageSlug) return null;
    return garmentChoices.find((c) => c.assetId === outfitImageSlug) ?? null;
  }, [outfitImageSlug, garmentChoices]);
  const subjectKind: CharacterSubjectKind = profile?.subject_kind ?? 'female';
  const activeFieldGroups = useMemo(() => fieldGroups(subjectKind), [subjectKind]);
  const isFreeform = isFreeformSubject(subjectKind);
  const selectedVoiceId = profile?.elevenlabs_voice_id ?? '';

  const { analyze, loading: analyzing } = useAnalyzeCharacterImage(callTool);
  const {
    customVoices,
    genericVoices,
    voices,
    loading: voicesLoading,
    loaded: voicesLoaded,
    error: voicesError,
    warning: voicesWarning,
    refresh: refreshVoices,
    ensureLoaded: ensureVoicesLoaded,
  } = useElevenLabsVoices(callTool, callState);
  const lastAnalyzedRef = useRef<string | null>(null);
  const voiceSaveSeqRef = useRef(0);

  // When the dialog opens with a source, either seed from a supplied profile
  // (re-edit mode) or run vision extraction (new char-* from img-*).
  useEffect(() => {
    if (!open || !source || !projectSlug || callState !== 'ready') return;
    if (lastAnalyzedRef.current === source.assetId) return;
    lastAnalyzedRef.current = source.assetId;
    void (async () => {
      setAnalyzeError(null);
      setLastOutcomes([]);
      setAdditionalReferenceSlugs([]);
      setOutfitImageSlug(null);
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

  const setSubjectKind = useCallback((kind: CharacterSubjectKind) => {
    setProfile((prev) => {
      const base = prev ?? emptyProfile(source?.assetId ?? '');
      return { ...base, subject_kind: kind };
    });
  }, [source]);

  const handleReanalyze = useCallback(async () => {
    if (!source || !projectSlug || callState !== 'ready' || analyzing) return;
    setAnalyzeError(null);
    const kind = profile?.subject_kind ?? 'female';
    const extracted = await analyze(projectSlug, source.assetId, kind);
    if (extracted) {
      setProfile(profile?.elevenlabs_voice_id ? { ...extracted, elevenlabs_voice_id: profile.elevenlabs_voice_id } : extracted);
    } else {
      setAnalyzeError('Vision extraction failed. Edit the fields manually and click Generate.');
    }
  }, [source, projectSlug, callState, analyzing, profile, analyze]);

  const toggleAdditionalReference = useCallback((assetId: string) => {
    setAdditionalReferenceSlugs((prev) => {
      if (prev.includes(assetId)) return prev.filter((id) => id !== assetId);
      if (prev.length >= MAX_ADDITIONAL_REFERENCES) return prev;
      return [...prev, assetId];
    });
  }, []);

  const handleVoiceChange = useCallback((voiceId: string) => {
    const nextProfile = profileWithVoiceId(profile, source?.assetId ?? '', voiceId);
    setProfile(nextProfile);
    if (!projectSlug || callState !== 'ready' || !source?.assetId.startsWith('char-')) return;

    const seq = voiceSaveSeqRef.current + 1;
    voiceSaveSeqRef.current = seq;
    setVoiceSaving(true);
    void (async () => {
      try {
        const res = await callTool('set_character_voice', {
          project_slug: projectSlug,
          char_asset_id: source.assetId,
          elevenlabs_voice_id: voiceId.trim(),
        });
        if (seq !== voiceSaveSeqRef.current) return;
        const content = res.content as Array<{ type: string; text: string }> | undefined;
        const text = content?.[0]?.text;
        if (res.isError) {
          toast({ title: 'Save voice failed', description: text ?? 'set_character_voice failed', duration: 4000 });
          return;
        }
        if (!text) return;
        const parsed = JSON.parse(text) as { profile?: CharacterProfile };
        if (parsed.profile) onProfileSaved?.(parsed.profile);
      } catch (e) {
        if (seq !== voiceSaveSeqRef.current) return;
        toast({ title: 'Save voice failed', description: e instanceof Error ? e.message : String(e), duration: 4000 });
      } finally {
        if (seq === voiceSaveSeqRef.current) setVoiceSaving(false);
      }
    })();
  }, [profile, source, projectSlug, callState, callTool, onProfileSaved]);

  const currentVoiceMissing = useMemo(() => {
    if (!selectedVoiceId) return false;
    return !voices.some((voice) => voice.voice_id === selectedVoiceId);
  }, [selectedVoiceId, voices]);

  const profileComplete = useMemo(() => {
    if (!profile) return false;
    return requiredFields(profile.subject_kind).every((key) => {
      const v = profile[key];
      return typeof v === 'string' && v.trim().length > 0;
    });
  }, [profile]);

  const canSubmit = !submitting && !analyzing && !!projectSlug && !!source && !!profile && profileComplete && selectedModels.size > 0;

  // Estimate cost for the fan-out: one image-edit job per selected model.
  // Adapters only exist for fal endpoints today, so the kie path falls back
  // to "—" via per-call warnings; the dialog's provider toggle gives the
  // user a clear path to a numeric estimate.
  const estimateCalls = useMemo<EstimateCall[] | null>(() => {
    if (callState !== 'ready' || selectedModels.size === 0) return null;
    if (selectedProvider !== 'fal') {
      return [...selectedModels].map((m) => ({
        toolName: `generate_${m}_kie_outfit`,
        input: {},
      }));
    }
    return [...selectedModels].map((m) => ({
      toolName: FAL_OUTFIT_TOOL_BY_MODEL[m],
      input: { prompt: 'character outfit edit', endpoint_id: FAL_OUTFIT_ENDPOINT_BY_MODEL[m] },
    }));
  }, [callState, selectedModels, selectedProvider]);
  const cost = useEstimateCost(callTool, { calls: estimateCalls });

  const handleGenerate = useCallback(async () => {
    if (!canSubmit || !projectSlug || !source || !profile) return;
    const res = await generate({
      projectSlug,
      sourceImageSlug: source.assetId,
      additionalReferenceImageSlugs: additionalReferenceSlugs,
      profile,
      models: [...selectedModels],
      provider: selectedProvider,
      outfitText: outfitText.trim() ? outfitText.trim() : undefined,
      outfitImageSlug: outfitImageSlug ?? undefined,
    });
    if (res) {
      setLastOutcomes(res.outcomes);
      if (res.enqueued > 0) onOpenChange(false);
    }
  }, [canSubmit, projectSlug, source, additionalReferenceSlugs, profile, selectedModels, selectedProvider, generate, outfitText, outfitImageSlug, onOpenChange]);

  const failedOutcomes = useMemo(
    () => lastOutcomes.filter((o) => !!o.error),
    [lastOutcomes],
  );

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
        <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-cyan-300/80 uppercase">
          <User className="w-3.5 h-3.5" />
          Character — Identity profile + 4-up reference sheet
        </div>
        <CloseButton tabIndex={-1} onClick={() => onOpenChange(false)} tone="cyan" aria-label="Close character view" />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden flex">
        <aside className="w-[340px] shrink-0 border-r border-border/50 overflow-y-auto px-4 py-4 space-y-4 bg-black/25">
          <section>
            <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/70 mb-1.5">Source</div>
            {source ? (
              <div className="flex gap-3 items-center">
                <div className="w-28 h-28 rounded border border-cyan-500/30 overflow-hidden bg-black shrink-0">
                  <img src={source.thumbUrl} alt={source.slug} className="w-full h-full object-cover" />
                </div>
                <div className="text-[11px] font-mono text-cyan-100 truncate" title={source.slug}>
                  {source.slug}
                </div>
              </div>
            ) : (
              <EmptyState size="sm" className="text-left">No source image selected. Run /character @img-… to seed one.</EmptyState>
            )}
          </section>

          {source && (
            <section>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/70">Extra references</div>
                <div className="text-[9px] font-mono text-cyan-400/50">
                  {additionalReferenceSlugs.length + 1}/3
                </div>
              </div>
              <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                {additionalReferenceChoices.slice(0, 24).map((g) => {
                  const active = additionalReferenceSlugs.includes(g.assetId);
                  const disabled = !active && additionalReferenceSlugs.length >= MAX_ADDITIONAL_REFERENCES;
                  return (
                    <button
                      key={g.assetId}
                      type="button"
                      onClick={() => toggleAdditionalReference(g.assetId)}
                      disabled={disabled}
                      title={g.slug}
                      className={cn(
                        'shrink-0 w-9 h-9 rounded border overflow-hidden bg-black transition-colors',
                        active
                          ? 'border-cyan-300'
                          : disabled
                          ? 'border-cyan-500/10 opacity-30 cursor-not-allowed'
                          : 'border-cyan-500/20 hover:border-cyan-400/60',
                      )}
                    >
                      <img src={g.thumbUrl} alt={g.slug} className="w-full h-full object-cover" />
                    </button>
                  );
                })}
                {additionalReferenceChoices.length === 0 && (
                  <EmptyState size="sm" className="text-left">No other image assets available.</EmptyState>
                )}
              </div>
            </section>
          )}

          <section>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/70">Subject</div>
              <button
                type="button"
                onClick={handleReanalyze}
                disabled={!source || !projectSlug || callState !== 'ready' || analyzing}
                title={`Re-run vision as ${subjectKind}`}
                className={cn(
                  'flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider rounded border transition-colors',
                  !source || !projectSlug || callState !== 'ready' || analyzing
                    ? 'border-zinc-700 text-zinc-500 cursor-not-allowed'
                    : 'border-cyan-500/30 text-cyan-300/80 hover:border-cyan-300 hover:text-cyan-100',
                )}
              >
                {analyzing ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />}
                Re-analyze as {subjectKind}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {SUBJECT_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setSubjectKind(kind)}
                  className={cn(
                    'px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                    subjectKind === kind
                      ? 'border-cyan-300 bg-cyan-500/15 text-cyan-100'
                      : 'border-cyan-500/20 text-cyan-300/60 hover:border-cyan-400/50',
                  )}
                >
                  {kind}
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/70">ElevenLabs voice</div>
              <button
                type="button"
                onClick={() => void refreshVoices()}
                disabled={callState !== 'ready' || voicesLoading || voiceSaving}
                title="Refresh voice IDs"
                className={cn(
                  'flex items-center justify-center w-6 h-6 rounded border transition-colors',
                  callState !== 'ready' || voicesLoading || voiceSaving
                    ? 'border-zinc-700 text-zinc-500 cursor-not-allowed'
                    : 'border-cyan-500/30 text-cyan-300/80 hover:border-cyan-300 hover:text-cyan-100',
                )}
              >
                {voicesLoading || voiceSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </button>
            </div>
            <select
              value={selectedVoiceId}
              disabled={analyzing || voiceSaving}
              onFocus={() => void ensureVoicesLoaded()}
              onPointerDown={() => void ensureVoicesLoaded()}
              onChange={(e) => handleVoiceChange(e.target.value)}
              className={cn(
                'w-full bg-black/40 border border-cyan-500/20 rounded px-2 py-1.5 text-[11px] font-mono text-cyan-100',
                'focus:border-cyan-400/40 focus:outline-none focus:ring-1 focus:ring-cyan-400/40',
              )}
            >
              <option value="">No voice</option>
              {(currentVoiceMissing || customVoices.length > 0) && (
                <optgroup label="Custom">
                  {currentVoiceMissing && <option value={selectedVoiceId}>{selectedVoiceId} · current</option>}
                  {customVoices.map((voice) => (
                    <option key={voice.voice_id} value={voice.voice_id}>
                      {voice.name} · {voice.voice_id}
                    </option>
                  ))}
                </optgroup>
              )}
              {genericVoices.length > 0 && (
                <optgroup label="Generic">
                  {genericVoices.map((voice) => (
                    <option key={voice.voice_id} value={voice.voice_id}>
                      {voice.name} · {voice.voice_id}
                    </option>
                  ))}
                </optgroup>
              )}
              {!voicesLoaded && !voicesLoading && !currentVoiceMissing && customVoices.length === 0 && genericVoices.length === 0 && (
                <option value="" disabled>Load voice IDs</option>
              )}
              {voicesLoading && <option value="" disabled>Loading voice IDs</option>}
            </select>
            {(voicesError || voicesWarning) && (
              <div className="mt-1 text-[9px] font-mono text-amber-300/70">
                {voicesError ?? voicesWarning}
              </div>
            )}
          </section>

          <section>
            <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/70 mb-1.5">
              {isFreeform ? 'Sheet accessory / costume' : 'Sheet outfit'}
            </div>
            <div className="flex gap-2 items-start">
              <input
                type="text"
                value={outfitText}
                placeholder={isFreeform ? 'e.g. red collar or tiny cape' : 'e.g. plain white t-shirt and dark jeans'}
                onChange={(e) => setOutfitText(e.target.value)}
                className={cn(
                  'flex-1 bg-black/40 border border-cyan-500/20 rounded px-2 py-1.5 text-[11px] font-mono text-cyan-100',
                  'focus:border-cyan-400/40 focus:outline-none focus:ring-1 focus:ring-cyan-400/40',
                )}
              />
              {outfitImage ? (
                <div className="relative w-12 h-12 rounded border border-cyan-500/40 overflow-hidden bg-black shrink-0">
                  <img src={outfitImage.thumbUrl} alt={outfitImage.slug} className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setOutfitImageSlug(null)}
                    aria-label="Remove garment reference"
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-900 border border-cyan-400/40 text-cyan-200 hover:bg-red-500/40 hover:border-red-400 flex items-center justify-center"
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
                      ? 'border-cyan-300'
                      : 'border-cyan-500/20 hover:border-cyan-400/60',
                  )}
                >
                  <img src={g.thumbUrl} alt={g.slug} className="w-full h-full object-cover" />
                </button>
              ))}
              {garmentChoices.length === 0 && (
                <EmptyState size="sm" className="text-left">No image assets in this project yet.</EmptyState>
              )}
            </div>
          </section>

          <section>
            <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/70 mb-1.5">Models</div>
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
                        ? 'border-cyan-300 bg-cyan-500/15 text-cyan-100'
                        : 'border-cyan-500/20 text-cyan-300/60 hover:border-cyan-400/50',
                    )}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/70 mb-1.5">Provider</div>
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
                        ? 'border-cyan-300 bg-cyan-500/15 text-cyan-100'
                        : 'border-cyan-500/20 text-cyan-300/60 hover:border-cyan-400/50',
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </section>

          {failedOutcomes.length > 0 && (
            <div className="space-y-1 text-[10px] font-mono text-red-300/80">
              {failedOutcomes.map((o) => (
                <div key={`${o.provider}-${o.model}`}>{o.model}: {o.error}</div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end">
            <CostBadge
              estimate={cost.estimate}
              loading={cost.loading}
              error={cost.error}
              stale={cost.stale}
              onRefresh={cost.refresh}
            />
          </div>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canSubmit}
            className={cn(
              'w-full flex items-center justify-center gap-2 px-4 py-2 rounded text-xs font-mono uppercase tracking-wider transition-colors',
              canSubmit
                ? 'bg-cyan-500/20 border border-cyan-300 text-cyan-100 hover:bg-cyan-500/30'
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
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/70">Profile</div>
            {analyzing && <Loader2 className="w-3 h-3 animate-spin text-cyan-300" />}
          </div>
          {analyzeError && (
            <div className="text-[10px] font-mono text-amber-400/80 mb-3">{analyzeError}</div>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {activeFieldGroups.map((group) => (
              <section key={group.title} className="min-w-0">
                <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/70 mb-1.5">{group.title}</div>
                <div className="grid grid-cols-2 gap-2">
                  {group.fields.map((key) => {
                    const f = fieldDef(key);
                    const value = profile?.[f.key] ?? '';
                    const Tag = f.multiline ? 'textarea' : 'input';
                    return (
                      <label key={f.key} className={cn('block min-w-0', f.multiline && 'col-span-2')}>
                        <div className="text-[9px] font-mono uppercase tracking-wider text-cyan-400/60 mb-0.5">
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
                            'w-full bg-black/40 border border-cyan-500/20 rounded px-2 py-1.5 text-[11px] font-mono text-cyan-100',
                            'focus:border-cyan-400/40 focus:outline-none focus:ring-1 focus:ring-cyan-400/40',
                            f.multiline ? 'min-h-[64px] resize-y' : '',
                          )}
                          rows={f.multiline ? 3 : undefined}
                        />
                      </label>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
