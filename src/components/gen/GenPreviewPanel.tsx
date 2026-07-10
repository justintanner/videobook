import { useState, useCallback, useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { Zap, Loader2, Settings, ImageIcon, Film } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMountKey } from '@/contexts/MountKeyContext';
import { GenPanel } from '@/components/gen/ui/GenPanel';
import { ModelProviderSelector } from '@/components/gen/ui/ModelSelector';
import { DynamicField } from '@/components/gen/ui/DynamicField';
import { ElementGroupEditor } from '@/components/gen/ElementGroupEditor';
import { MediaStrip, type CharacterPillData } from '@/components/gen/ui/MediaStrip';
import { CharacterPickerPopover } from '@/components/gen/ui/CharacterPickerPopover';
import { characterImageCount } from '@/components/gen/ui/media-strip';
import { sortFields, isAssetField, isElementField } from '@/components/gen/ui/fieldHelpers';
import { useGoogleFlowEntities } from '@/hooks/useGoogleFlowEntities';
import { stripAssetTagsFromText, stripSlugPrefix } from '@/lib/slugs';
import { ErrorPage } from '@/components/gen/state/ErrorPage';
import { JsonNode } from '@/components/ui/JsonNode';
import { ELEMENT_FIELD_RE } from '@/components/gen/types';
import type { FullPreviewResponse, ModelOption, JSONSchemaProperty, ResolvedAsset, ModeSpec } from '@/components/gen/types';
import {
  getMode,
  visibleParams,
  inferModeKey,
  filterValuesForMode,
  modeRequiredMissing,
  modeAssetParams,
  modeBudgetWarnings,
  effectiveToolName as resolveEffectiveToolName,
} from '@/components/gen/modes';
import type { ExecuteButtonState } from '@/components/commands/types';
import type { UseMcpResult } from 'use-mcp/react';
import { useRewriteImagePrompt, type ImagePromptGuideModel } from '@/hooks/useRewriteImagePrompt';
import type { ImagePromptRewriteSubmit } from '@/components/gen/ImagePromptRewritePopover';
import { useEstimateCost, type EstimateCall } from '@/hooks/useEstimateCost';
import { GenerateCommandButton } from '@/components/gen/GenerateCommandButton';
import { usePromptHistory } from '@/hooks/usePromptHistory';
import { GenSection } from '@/components/gen/ui/GenSection';
import { PromptSection } from '@/components/gen/ui/PromptSection';
import { genThemes } from '@/components/gen/ui/gen-themes';
import type { RichToken } from '@/components/ui/richPromptTokens';
import { characterHandle, rewriteCharacterMentions, stripOrphanedReferenceMarkers, renumberReferenceImageMarkers } from '@/components/ui/richPromptTokens';
import type { ChipThumb } from '@/components/ui/AssetThumbChip';
import { createGenerationRequestId } from '@/lib/generation-lifecycle';
import type { OnGenerationLifecycle } from '@/lib/generation-lifecycle';

export interface GenPreviewPanelHandle {
  setField: (name: string, value: string) => void;
  setModel: (key: string) => void;
  setImages: (slugs: string) => void;
  setElement: (index: string, field: string, value: string) => void;
}

interface GenPreviewPanelProps {
  category: 'video' | 'image';
  prompt: string;
  onClose: () => void;
  callTool: UseMcpResult['callTool'];
  /** MCP connection state — used by list-tool pickers (voice/character refs). */
  mcpState?: UseMcpResult['state'];
  projectSlug: string | undefined;
  /** True while a generation of this category is still running in the
   *  background — dims the /generate button (kept clickable). */
  pendingGeneration?: boolean;
  onGenerationLifecycle?: OnGenerationLifecycle;
  /** Project image assets offered in the prompt's @ autocomplete (picking one
   *  appends it to image_slugs and inserts @referenceImage_N). */
  imageAssets?: { slug: string; filePath: string; thumbnailSrc: string | null }[];
}

function getPreviewToolName(cat: 'video' | 'image'): string {
  return cat === 'video' ? 'preview_video' : 'preview_image';
}

// Map an image panel model key (from server's image-models.ts) to the
// rewrite_prompt tool's guide-model enum. Falls back to gpt_image for models
// that don't have their own prompting guide.
const IMAGE_MODEL_TO_GUIDE: Record<string, ImagePromptGuideModel> = {
  nano_banana: 'nano_banana',
  grok_imagine_image: 'grok_imagine',
  grok_imagine_text: 'grok_imagine',
  gpt_image: 'gpt_image',
  gpt_image_text: 'gpt_image',
};

function guideModelFor(imageModelKey: string | undefined): ImagePromptGuideModel {
  if (!imageModelKey) return 'gpt_image';
  return IMAGE_MODEL_TO_GUIDE[imageModelKey] ?? 'gpt_image';
}

const VIDEO_REWRITE_MODELS: ReadonlySet<string> = new Set(['gemini_omni']);

interface SavedGenSettings {
  model: string;
  provider: string;
  mode?: string;
  fields: Record<string, unknown>;
  droppedAssets?: Array<{ slug: string; src: string; thumbnailSrc?: string | null; type: 'image' | 'video' | 'audio' | 'character' }>;
}

function genSettingsKey(category: string, projectSlug?: string): string {
  return projectSlug
    ? `videocity:gen:${category}:${projectSlug}`
    : `videocity:gen:${category}`;
}

function loadGenSettings(category: string, projectSlug?: string): SavedGenSettings | null {
  try {
    const raw = localStorage.getItem(genSettingsKey(category, projectSlug));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveGenSettings(category: string, projectSlug: string | undefined, data: SavedGenSettings): void {
  try {
    localStorage.setItem(genSettingsKey(category, projectSlug), JSON.stringify(data));
  } catch { /* ignore quota errors */ }
}

export const GenPreviewPanel = forwardRef<GenPreviewPanelHandle, GenPreviewPanelProps>(function GenPreviewPanel({
  category,
  prompt: initialPrompt,
  onClose,
  callTool,
  mcpState,
  projectSlug,
  pendingGeneration,
  onGenerationLifecycle,
  imageAssets,
}, ref) {
  useMountKey('gen');

  const [preview, setPreview] = useState<FullPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [selectedProviderKey, setSelectedProviderKey] = useState('');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [droppedAssets, setDroppedAssets] = useState<Map<string, ResolvedAsset>>(new Map());
  const [genState, setGenState] = useState<ExecuteButtonState | undefined>(undefined);
  const [flipped, setFlipped] = useState(false);
  const [translatedPayload, setTranslatedPayload] = useState<Record<string, unknown> | null>(null);
  const [translateLoading, setTranslateLoading] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const { rewrite: rewriteImagePrompt, rewriting } = useRewriteImagePrompt(callTool);
  const promptHistorySurface = category === 'video' ? 'video_generate' : 'image_generate';
  const promptHistory = usePromptHistory(callTool, promptHistorySurface, projectSlug);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const formValuesRef = useRef(formValues);
  formValuesRef.current = formValues;
  const refreshIdRef = useRef(0);
  const savedRef = useRef(loadGenSettings(category, projectSlug));
  const appliedSavedRef = useRef(false);
  // Holds the pending success→idle reset timer so it can be cancelled on
  // unmount, avoiding a setGenState call on an unmounted component.
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
  }, []);

  const fetchPreview = useCallback(async (
    cat: 'video' | 'image',
    prompt: string,
    overrides?: { selected_model?: string; selected_provider?: string },
  ) => {
    if (!projectSlug) return;
    const isRefresh = !!overrides;
    const thisRequest = ++refreshIdRef.current;
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setPreview(null);
    }
    setError(null);
    try {
      const toolArgs: Record<string, unknown> = { prompt, project_slug: projectSlug };
      if (overrides?.selected_model) toolArgs.selected_model = overrides.selected_model;
      if (overrides?.selected_provider) toolArgs.selected_provider = overrides.selected_provider;

      const result = await callToolRef.current(getPreviewToolName(cat), toolArgs);
      if (thisRequest !== refreshIdRef.current) return; // stale
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }>;
        setError(content[0]?.text ?? 'Preview failed');
        return;
      }
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0].text) as FullPreviewResponse;
      setPreview(data);
      setSelectedModelKey(data.selected_model);
      const option = data.model_options.find((o) => o.key === data.selected_model);
      setSelectedProviderKey(option?.selected_provider ?? data.selected_provider ?? '');
      const currentValues = formValuesRef.current;
      const currentPrompt = isRefresh ? currentValues.prompt : undefined;
      const prefilled = option?.prefilled_values ?? {};
      const prefilledPrompt = (prefilled as { prompt?: unknown }).prompt;
      const seededPrompt = currentPrompt
        ?? (typeof prefilledPrompt === 'string' ? stripAssetTagsFromText(prefilledPrompt) : undefined)
        ?? stripAssetTagsFromText(prompt ?? '');
      const preservedSlugFields: Record<string, unknown> = {};
      if (isRefresh) {
        const modeSlugParams = option?.modes ? modeAssetParams(option.modes) : null;
        const isSlugField = (k: string): boolean =>
          (modeSlugParams?.has(k) ?? isAssetField(k)) || /^element\d+_slugs$/.test(k);
        for (const [k, v] of Object.entries(currentValues)) {
          if (isSlugField(k)) {
            preservedSlugFields[k] = v;
          }
        }
      }
      const mergedValues = { ...prefilled, ...preservedSlugFields, prompt: seededPrompt };
      setFormValues(mergedValues);
      if (!isRefresh) setDroppedAssets(new Map());
    } catch (e) {
      if (thisRequest !== refreshIdRef.current) return;
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      if (thisRequest === refreshIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [projectSlug]);

  // Fetch preview on mount
  const hasFetched = useRef(false);
  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    const saved = savedRef.current;
    fetchPreview(category, initialPrompt, saved ? {
      selected_model: saved.model,
      selected_provider: saved.provider,
    } : undefined);
  }, [category, initialPrompt, fetchPreview]);

  // Restore saved settings after initial preview loads
  useEffect(() => {
    if (!preview || appliedSavedRef.current) return;
    appliedSavedRef.current = true;
    const saved = savedRef.current;
    if (!saved?.fields) return;
    const option = preview.model_options.find(o => o.key === selectedModelKey);
    if (!option?.schema) return;
    const overrides: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(saved.fields)) {
      if (key in option.schema.properties && key !== 'prompt' && key !== 'project_slug') {
        const prop = option.schema.properties[key];
        if (prop.enum && !(prop.enum as unknown[]).includes(value)) continue;
        overrides[key] = value;
      }
    }
    if (Object.keys(overrides).length > 0) {
      setFormValues(prev => ({ ...prev, ...overrides }));
    }
    if (saved.droppedAssets?.length) {
      setDroppedAssets(new Map(saved.droppedAssets.map(a => [a.slug, a])));
    }
  }, [preview, selectedModelKey]);

  const handleModelProviderChange = useCallback((modelKey: string, providerKey: string) => {
    setSelectedModelKey(modelKey);
    setSelectedProviderKey(providerKey);
    setGenState(undefined);
    setFlipped(false);
    setTranslatedPayload(null);
    setTranslateLoading(false);
    fetchPreview(category, initialPrompt, {
      selected_model: modelKey || undefined,
      selected_provider: providerKey || undefined,
    });
  }, [category, initialPrompt, fetchPreview]);

  useImperativeHandle(ref, () => ({
    setField: (name: string, value: string) => {
      setFormValues((prev) => ({ ...prev, [name]: value }));
    },
    setModel: (key: string) => {
      handleModelProviderChange(key, selectedProviderKey);
    },
    setImages: (slugs: string) => {
      const slugList = slugs.split(/\s+/).map((s) => s.startsWith('@') ? s : `@${s}`).filter(Boolean);
      setFormValues((prev) => ({ ...prev, image_slugs: slugList }));
    },
    setElement: (index: string, field: string, value: string) => {
      const key = `element${index}_${field === 'slugs' ? 'slugs' : field === 'name' ? 'name' : 'desc'}`;
      if (field === 'slugs') {
        const slugList = value.split(/\s+/).map((s) => s.startsWith('@') ? s : `@${s}`).filter(Boolean);
        setFormValues((prev) => ({ ...prev, [key]: slugList }));
      } else {
        setFormValues((prev) => ({ ...prev, [key]: value }));
      }
    },
  }), [handleModelProviderChange, selectedProviderKey]);

  const handleFieldChange = useCallback((fieldName: string, value: unknown, dropped?: ResolvedAsset) => {
    setFormValues((prev) => ({ ...prev, [fieldName]: value }));
    if (dropped) {
      setDroppedAssets((prev) => {
        const next = new Map(prev);
        next.set(dropped.slug, dropped);
        return next;
      });
    }
  }, []);

  // Appends an image asset to image_slugs (or returns its existing 1-based
  // index if already a ref) for the prompt @ autocomplete. The resolved asset
  // is registered in droppedAssets so its thumbnail resolves and it survives
  // the stale-slug pruning effect even when absent from preview.resolved_assets.
  const handlePickImageAsset = useCallback((slug: string): number | null => {
    const clean = slug.startsWith('@') ? slug : `@${slug}`;
    const current = Array.isArray(formValues.image_slugs) ? (formValues.image_slugs as string[]) : [];
    const existingIdx = current.indexOf(clean);
    if (existingIdx >= 0) return existingIdx + 1;
    const next = [...current, clean];
    const matched = imageAssets?.find((a) => a.slug === slug || a.slug === clean);
    const dropped: ResolvedAsset | undefined = matched
      ? { slug: clean, src: matched.filePath, thumbnailSrc: matched.thumbnailSrc ?? null, type: 'image' }
      : undefined;
    handleFieldChange('image_slugs', next, dropped);
    return next.length;
  }, [formValues.image_slugs, imageAssets, handleFieldChange]);

  // Wrap the media strip's onChange so removing an image_slugs entry (shrink by
  // exactly one) renumbers @referenceImage_N markers in the prompt to match.
  // Every other field falls through to handleFieldChange. The submit-time
  // stripOrphanedReferenceMarkers remains the safety net.
  const handleStripChange = useCallback((field: string, value: unknown, dropped?: ResolvedAsset) => {
    if (field === 'image_slugs') {
      const prev = Array.isArray(formValues.image_slugs) ? (formValues.image_slugs as string[]) : [];
      const next = Array.isArray(value) ? (value as string[]) : [];
      if (next.length === prev.length - 1) {
        let removedIdx = -1;
        for (let i = 0; i < prev.length; i++) {
          if (prev[i] !== next[i]) { removedIdx = i; break; }
        }
        if (removedIdx === -1) removedIdx = prev.length - 1;
        const currentPrompt = typeof formValues.prompt === 'string' ? formValues.prompt : '';
        const renumbered = renumberReferenceImageMarkers(currentPrompt, removedIdx + 1);
        setFormValues((p) => ({ ...p, image_slugs: next, prompt: renumbered }));
        if (dropped) {
          setDroppedAssets((prevMap) => {
            const m = new Map(prevMap);
            m.set(dropped.slug, dropped);
            return m;
          });
        }
        return;
      }
    }
    handleFieldChange(field, value, dropped);
  }, [formValues.image_slugs, formValues.prompt, handleFieldChange]);

  const selectedOption: ModelOption | undefined = preview?.model_options.find(
    (o) => o.key === selectedModelKey,
  );

  // --- Mode derivation (only meaningful when the option ships a modes contract) ---
  const modes = selectedOption?.modes ?? null;
  // Active mode is DERIVED from filled values (video → edit, images/characters
  // → refs, pinned first-frame → i2v, else t2v) — no user-driven tabs.
  const activeModeKey = useMemo(
    () => (modes ? inferModeKey(modes, formValues) : null),
    [modes, formValues],
  );
  const activeMode: ModeSpec | null = modes ? getMode(modes, activeModeKey) : null;
  const modeVisible = useMemo(
    () => (modes && activeMode ? visibleParams(modes, activeMode.key) : null),
    [modes, activeMode],
  );
  // Params filtered to the active mode drive submit, cost, and the flip view.
  const submitValues = useMemo(
    () => (modes && activeMode ? filterValuesForMode(modes, activeMode.key, formValues) : formValues),
    [modes, activeMode, formValues],
  );
  const submitToolName = selectedOption
    ? resolveEffectiveToolName(selectedOption, activeModeKey)
    : undefined;
  // Union of every asset-slot param across the model's modes — used to
  // generalize slug preservation/pruning off the field-name allowlist.
  const optionAssetParams = useMemo(
    () => (modes ? modeAssetParams(modes) : null),
    [modes],
  );
  const isAssetParam = useCallback(
    (name: string): boolean => optionAssetParams?.has(name) ?? isAssetField(name),
    [optionAssetParams],
  );

  // Drop slug values that can't be resolved against the current preview's
  // resolved_assets (or local droppedAssets). Stale slugs — restored from
  // localStorage or leftover from a prior preview — otherwise render as
  // placeholder-labeled slots with no thumb.
  useEffect(() => {
    if (!preview || !selectedOption) return;
    const resolved = preview.resolved_assets ?? [];
    // The savedRef fallback covers the initial-mount race: when this filter's
    // queued setFormValues callback runs during state-queue processing, the
    // droppedAssets closure is still the pre-restore empty Map. Consulting the
    // immutable savedRef directly ensures we never strip slugs the user
    // explicitly dropped before the panel was last closed.
    const savedDroppedSlugs = new Set((savedRef.current?.droppedAssets ?? []).map((a) => a.slug));
    const canResolve = (slug: string): boolean => {
      if (!slug) return false;
      if (droppedAssets.has(slug)) return true;
      if (savedDroppedSlugs.has(slug)) return true;
      const clean = stripSlugPrefix(slug);
      return resolved.some((a) => {
        const aClean = a.slug ? stripSlugPrefix(a.slug) : a.slug;
        return a.slug === slug || a.slug === clean || aClean === clean;
      });
    };
    const isSlugField = (name: string): boolean =>
      isAssetParam(name) || /^element\d+_slugs$/.test(name);

    setFormValues((prev) => {
      let changed = false;
      const next: Record<string, unknown> = { ...prev };
      for (const name of Object.keys(prev)) {
        if (!isSlugField(name)) continue;
        const v = prev[name];
        if (typeof v === 'string' && v && !canResolve(v)) {
          next[name] = '';
          changed = true;
        } else if (Array.isArray(v)) {
          const filtered = (v as unknown[]).filter(
            (s): s is string => typeof s === 'string' && canResolve(s),
          );
          if (filtered.length !== v.length) {
            next[name] = filtered;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [preview, droppedAssets, selectedOption, isAssetParam]);

  // All video/image models (sorted) feed the fused model·provider dropdown.
  const sortedModelOptions = useMemo(() => {
    if (!preview) return [];
    return preview.model_options.slice().sort((a, b) => a.label.localeCompare(b.label));
  }, [preview]);

  const jsonPayload = useMemo(() => {
    if (!selectedOption || !submitToolName) return null;
    return {
      tool_name: submitToolName,
      args: { ...submitValues, project_slug: projectSlug, _provider: selectedProviderKey },
    };
  }, [selectedOption, submitToolName, submitValues, projectSlug, selectedProviderKey]);

  const estimateCalls = useMemo<EstimateCall[] | null>(() => {
    if (!selectedOption || !submitToolName) return null;
    // project_slug lets the server resolve duration-priced models like
    // kling-3.0/motion-control where the billable seconds come from the input
    // motion video, not a user-typed parameter.
    const input: Record<string, unknown> = projectSlug
      ? { ...submitValues, project_slug: projectSlug }
      : submitValues;
    return [{ toolName: submitToolName, input }];
  }, [selectedOption, submitToolName, submitValues, projectSlug]);
  const cost = useEstimateCost(callTool, { calls: estimateCalls });
  const charEntities = useGoogleFlowEntities('character', category === 'video' ? callTool : undefined, mcpState);
  const characterRefs = useMemo(
    () =>
      Array.isArray(formValues.character_refs)
        ? (formValues.character_refs as string[]).filter((s) => s.trim() !== '')
        : [],
    [formValues.character_refs],
  );
  const charMap = useMemo(
    () => new Map(charEntities.entities.map((e) => [e.ref, e])),
    [charEntities.entities],
  );
  const charMentions = useMemo(
    () =>
      characterRefs.map((ref, i) => {
        const name = charMap.get(ref)?.displayName ?? ref;
        return { ref, handle: characterHandle(name), label: name, n: i + 1 };
      }),
    [characterRefs, charMap],
  );
  const charHandles = useMemo(() => charMentions.map((c) => c.handle), [charMentions]);

  const handleRewritePromptSubmit = useCallback(async (
    submit: ImagePromptRewriteSubmit,
  ) => {
    if (!projectSlug) return;
    const currentValues = formValuesRef.current;
    const currentPrompt = typeof currentValues.prompt === 'string' ? currentValues.prompt : '';
    const rawSlugs = currentValues.image_slugs;
    const currentImageSlugs = Array.isArray(rawSlugs)
      ? (rawSlugs as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

    if (category === 'video' && VIDEO_REWRITE_MODELS.has(selectedModelKey)) {
      const rewrittenMentions = rewriteCharacterMentions(currentPrompt, charMentions.map((c) => ({ handle: c.handle, n: c.n })));
      const outImageSlugs = currentImageSlugs.filter((s) => s.trim() !== '');
      const outCharacterRefs = Array.isArray(currentValues.character_refs)
        ? (currentValues.character_refs as string[]).filter((s) => s.trim() !== '')
        : [];
      const outVoiceRefs = Array.isArray(currentValues.voice_refs)
        ? (currentValues.voice_refs as string[]).filter((s) => s.trim() !== '')
        : [];
      const cleanedPrompt = stripOrphanedReferenceMarkers(rewrittenMentions, {
        character: outCharacterRefs.length,
        referenceImage: outImageSlugs.length,
        referenceAudio: outVoiceRefs.length,
      });
      const rewritten = await rewriteImagePrompt({
        prompt: cleanedPrompt,
        model: selectedModelKey as ImagePromptGuideModel,
        imageSlugs: outImageSlugs,
        providerDocs: true,
        customPrompt: submit.customPrompt,
        projectSlug,
      });
      if (rewritten) {
        setFormValues((prev) => ({ ...prev, prompt: rewritten }));
        setRewriteOpen(false);
      }
      return;
    }

    const filteredImageSlugs = currentImageSlugs.filter((s) => s.trim() !== '');
    const rewritten = await rewriteImagePrompt({
      prompt: currentPrompt,
      model: guideModelFor(selectedModelKey),
      imageSlugs: filteredImageSlugs,
      platform: submit.platform,
      providerDocs: submit.providerDocs,
      customPrompt: submit.customPrompt,
      projectSlug,
    });
    if (rewritten) {
      setFormValues((prev) => ({ ...prev, prompt: rewritten }));
      setRewriteOpen(false);
    }
  }, [projectSlug, selectedModelKey, rewriteImagePrompt, category, charMentions]);

  const characterPills = useMemo<CharacterPillData[]>(
    () =>
      characterRefs.map((ref) => {
        const e = charMap.get(ref);
        return {
          ref,
          name: e?.displayName ?? ref,
          thumbnailUrl: e?.thumbnailUrl ?? null,
          imageCount: characterImageCount(ref, e ? { image_count: e.image_count } : null),
        };
      }),
    [characterRefs, charMap],
  );
  const allCharMentions = useMemo(
    () =>
      charEntities.entities.map((e) => ({
        handle: characterHandle(e.displayName),
        label: e.displayName,
        ref: e.ref,
      })),
    [charEntities.entities],
  );
  const handlePickCharacter = useCallback(
    (ref: string) => {
      if (!ref) return;
      const current = Array.isArray(formValues.character_refs)
        ? (formValues.character_refs as string[]).filter((s) => s.trim() !== '')
        : [];
      if (current.includes(ref)) return;
      handleFieldChange('character_refs', [...current, ref]);
    },
    [formValues.character_refs, handleFieldChange],
  );
  const handleRemoveCharacter = useCallback(
    (ref: string) => {
      const current = Array.isArray(formValues.character_refs)
        ? (formValues.character_refs as string[]).filter((s) => s.trim() !== '')
        : [];
      handleFieldChange('character_refs', current.filter((r) => r !== ref));
    },
    [formValues.character_refs, handleFieldChange],
  );
  const voiceEntities = useGoogleFlowEntities('voice', category === 'video' ? callTool : undefined, mcpState);
  const voiceMap = useMemo(
    () => new Map(voiceEntities.entities.map((e) => [e.ref, e])),
    [voiceEntities.entities],
  );
  const imageSlugs = useMemo(
    () =>
      Array.isArray(formValues.image_slugs)
        ? (formValues.image_slugs as string[]).filter((s) => s.trim() !== '')
        : [],
    [formValues.image_slugs],
  );
  const voiceRefs = useMemo(
    () =>
      Array.isArray(formValues.voice_refs)
        ? (formValues.voice_refs as string[]).filter((s) => s.trim() !== '')
        : [],
    [formValues.voice_refs],
  );
  const resolvedAssetMap = useMemo(() => {
    const m = new Map<string, ResolvedAsset>();
    for (const a of preview?.resolved_assets ?? []) m.set(a.slug, a);
    for (const [, a] of droppedAssets) m.set(a.slug, a);
    return m;
  }, [preview?.resolved_assets, droppedAssets]);
  const referenceImageSlots = useMemo(
    () =>
      imageSlugs.map((slug, i) => {
        const asset = resolvedAssetMap.get(slug);
        return { n: i + 1, slug, thumbnailSrc: asset?.thumbnailSrc ?? null, label: slug };
      }),
    [imageSlugs, resolvedAssetMap],
  );
  const referenceVoiceSlots = useMemo(
    () =>
      voiceRefs.map((ref, i) => {
        const voice = voiceMap.get(ref);
        return { n: i + 1, ref, label: voice?.displayName ?? ref };
      }),
    [voiceRefs, voiceMap],
  );
  const promptResolveRef = useCallback(
    (token: RichToken): ChipThumb | null => {
      if (token.kind === 'character-ref') {
        const m = charMentions.find((c) => c.handle === token.handle);
        if (!m) return null;
        return {
          thumbnailSrc: charMap.get(m.ref)?.thumbnailUrl ?? null,
          type: 'character',
          label: m.label !== m.ref ? m.label : `Character ${m.n}`,
          badge: String(m.n),
        };
      }
      if (token.kind === 'character-slot') {
        const m = charMentions.find((c) => c.n === token.n);
        if (!m) return null;
        return {
          thumbnailSrc: charMap.get(m.ref)?.thumbnailUrl ?? null,
          type: 'character',
          label: m.label !== m.ref ? m.label : `Character ${m.n}`,
          badge: String(m.n),
        };
      }
      if (token.kind === 'reference-image-slot') {
        const slot = referenceImageSlots.find((s) => s.n === token.n);
        if (!slot) return null;
        return {
          thumbnailSrc: slot.thumbnailSrc,
          type: 'image',
          label: slot.label,
          badge: String(slot.n),
        };
      }
      if (token.kind === 'reference-audio-slot') {
        const slot = referenceVoiceSlots.find((s) => s.n === token.n);
        if (!slot) return null;
        return {
          thumbnailSrc: null,
          type: 'audio',
          label: slot.label,
          badge: String(slot.n),
        };
      }
      return null;
    },
    [charMentions, charMap, referenceImageSlots, referenceVoiceSlots],
  );

  // Live validation warnings derived from current form values
  const liveWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (selectedOption?.tool_name === 'generate_wan27_i2v_video') {
      const hasClip = !!formValues.first_clip_slug;
      const hasFirst = !!formValues.first_frame_slug;
      const hasLast = !!formValues.last_frame_slug;
      if (hasClip && hasFirst && hasLast) {
        warnings.push('Wan 2.7 Image to Video does not support first_clip combined with both first_frame and last_frame. Use first_clip alone, first_clip + one frame, or first_frame + last_frame without a clip.');
      }
    }
    if (
      selectedOption?.tool_name === 'generate_seedance2_video'
      || selectedOption?.tool_name === 'generate_seedance2_fast_video'
    ) {
      const audio = formValues.audio_slugs;
      const hasAudio = Array.isArray(audio) && audio.some((s) => typeof s === 'string' && s.length > 0);
      const hasFrame = !!formValues.first_frame_slug || !!formValues.last_frame_slug;
      if (hasAudio && hasFrame) {
        warnings.push('Seedance 2 does not support reference audio combined with first/last frame — pick one or the other.');
      }
    }
    // Data-driven per-mode budget overflow (e.g. 7 refs carried into a mode
    // that caps them at 5). Server validation remains authoritative at submit.
    if (activeMode) {
      warnings.push(...modeBudgetWarnings(activeMode, formValues));
    }
    return warnings;
  }, [selectedOption?.tool_name, activeMode, formValues]);

  // Live required-field check derived from current form values. The server
  // computes validation.missing_required once at preview time; this recomputes
  // against the latest formValues so disabling tracks user input live.
  const liveMissingRequired = useMemo(() => {
    // Base schema requireds, plus the active mode's requireds, restricted to
    // params visible in the current mode (a hidden mode's required slug must
    // not block generation).
    const schemaRequired = (selectedOption?.schema.required ?? [])
      .filter((name) => !modeVisible || modeVisible.has(name));
    const modeRequired = activeMode ? modeRequiredMissing(activeMode, formValues) : [];
    const required = Array.from(new Set([...schemaRequired, ...modeRequired]));
    const missing: string[] = [];
    for (const name of required) {
      if (name === 'project_slug') continue;
      const v = formValues[name];
      if (v === undefined || v === null || v === '') missing.push(name);
      else if (Array.isArray(v) && v.length === 0) missing.push(name);
    }
    return missing;
  }, [selectedOption?.schema.required, activeMode, modeVisible, formValues]);

  const missingRequiredLabel = (name: string): string =>
    name.replace(/_slugs?$/, '').replace(/_/g, ' ');

  // Bucket validation warnings by the section they relate to so each renders
  // inline with its target instead of as a top-of-form banner.
  const routedWarnings = useMemo(() => {
    const buckets: { prompt: string[]; references: string[]; settings: string[]; general: string[] } = {
      prompt: [],
      references: [],
      settings: [],
      general: [],
    };
    if (!selectedOption) return buckets;
    const settingsFieldKeys = Object.keys(selectedOption.schema.properties).filter(
      (n) => n !== 'project_slug' && n !== 'prompt' && !isAssetField(n) && !isElementField(n),
    );
    const settingsTokens = settingsFieldKeys.flatMap((k) => [k, k.replace(/_/g, ' ')]);
    const REFERENCE_TOKENS = /\b(reference|frame|clip|slug|asset|image|video|audio)s?\b/i;

    const route = (msg: string): keyof typeof buckets => {
      const lower = msg.toLowerCase();
      if (/^missing required field/i.test(msg)) {
        if (/\bprompt\b/.test(lower)) return 'prompt';
        if (settingsTokens.some((t) => lower.includes(t.toLowerCase()))) return 'settings';
        return 'references';
      }
      if (REFERENCE_TOKENS.test(msg)) return 'references';
      if (settingsTokens.some((t) => lower.includes(t.toLowerCase()))) return 'settings';
      return 'general';
    };

    const missingToDisplay = liveMissingRequired.filter((n) => n !== 'prompt');
    if (missingToDisplay.length > 0) {
      const composed = `Missing required field${missingToDisplay.length === 1 ? '' : 's'}: ${missingToDisplay.map(missingRequiredLabel).join(', ')}`;
      buckets[route(composed)].push(composed);
    }
    for (const w of selectedOption.validation.warnings ?? []) {
      buckets[route(w)].push(w);
    }
    for (const w of liveWarnings) {
      buckets[route(w)].push(w);
    }
    return buckets;
  }, [selectedOption, liveMissingRequired, liveWarnings]);

  const fetchTranslatedPayload = useCallback(async () => {
    if (!jsonPayload) return;
    setTranslateLoading(true);
    try {
      const result = await callToolRef.current('translate_payload', {
        tool_name: jsonPayload.tool_name,
        args_json: JSON.stringify(jsonPayload.args),
      });
      if (!result.isError) {
        const content = result.content as Array<{ type: string; text: string }>;
        setTranslatedPayload(JSON.parse(content[0].text) as Record<string, unknown>);
      } else {
        setTranslatedPayload(null);
      }
    } catch {
      setTranslatedPayload(null);
    } finally {
      setTranslateLoading(false);
    }
  }, [jsonPayload]);

  const handleGenerate = useCallback(async () => {
    if (!selectedOption || !projectSlug) return;
    const requestId = createGenerationRequestId(category);
    const submittedPrompt = typeof formValues.prompt === 'string' ? formValues.prompt : '';
    onGenerationLifecycle?.({
      phase: 'started',
      requestId,
      category,
      prompt: submittedPrompt,
    });
    setGenState('submitting');
    // Persist settings for next generation
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(selectedOption.schema.properties)) {
      if (key !== 'prompt' && key !== 'project_slug' && key in formValues) {
        fields[key] = formValues[key];
      }
    }
    const droppedArr = Array.from(droppedAssets.entries()).map(([, a]) => ({
      slug: a.slug, src: a.src, thumbnailSrc: a.thumbnailSrc ?? null, type: a.type,
    }));
    saveGenSettings(category, projectSlug, { model: selectedModelKey, provider: selectedProviderKey, fields, droppedAssets: droppedArr });
    try {
      // Filter to the active mode's params (no-op for non-moded models) and
      // resolve the mode's tool. The wire payload stays byte-identical since
      // the omni tool coalesces absent/blank identically.
      const outValues = modes && activeMode ? filterValuesForMode(modes, activeMode.key, formValues) : formValues;
      const outToolName = resolveEffectiveToolName(selectedOption, activeModeKey);
      const rewrittenPrompt = rewriteCharacterMentions(
        typeof outValues.prompt === 'string' ? outValues.prompt : '',
        charMentions.map((c) => ({ handle: c.handle, n: c.n })),
      );
      const outImageSlugs = Array.isArray(outValues.image_slugs)
        ? (outValues.image_slugs as string[]).filter((s) => s.trim() !== '')
        : [];
      const outCharacterRefs = Array.isArray(outValues.character_refs)
        ? (outValues.character_refs as string[]).filter((s) => s.trim() !== '')
        : [];
      const outVoiceRefs = Array.isArray(outValues.voice_refs)
        ? (outValues.voice_refs as string[]).filter((s) => s.trim() !== '')
        : [];
      const cleanedPrompt = stripOrphanedReferenceMarkers(rewrittenPrompt, {
        character: outCharacterRefs.length,
        referenceImage: outImageSlugs.length,
        referenceAudio: outVoiceRefs.length,
      });
      const args: Record<string, unknown> = { ...outValues, prompt: cleanedPrompt, project_slug: projectSlug, _provider: selectedProviderKey };
      const result = await callToolRef.current(outToolName, args);
      if (result.isError) {
        onGenerationLifecycle?.({ phase: 'failed', requestId });
        setGenState(undefined);
        const content = result.content as Array<{ type: string; text: string }>;
        setError(content[0]?.text ?? 'Generation failed');
      } else {
        if (submittedPrompt.trim()) {
          promptHistory.push(submittedPrompt, {
            model: selectedModelKey,
            provider: selectedProviderKey,
          });
        }
        const content = result.content as Array<{ type: string; text: string }>;
        let assetId: string | undefined;
        try {
          const parsed = JSON.parse(content[0]?.text ?? '{}') as { vid_asset_id?: string; img_asset_id?: string };
          assetId = parsed.vid_asset_id ?? parsed.img_asset_id;
        } catch {
          assetId = undefined;
        }
        if (assetId) {
          onGenerationLifecycle?.({ phase: 'submitted', requestId, assetId });
        } else {
          onGenerationLifecycle?.({ phase: 'failed', requestId });
        }
        setGenState('success');
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => {
          successTimerRef.current = null;
          setGenState(undefined);
        }, 1200);
      }
    } catch (e) {
      onGenerationLifecycle?.({ phase: 'failed', requestId });
      setGenState(undefined);
      setError(e instanceof Error ? e.message : 'Generation failed');
    }
  }, [selectedOption, formValues, projectSlug, selectedProviderKey, category, selectedModelKey, droppedAssets, promptHistory, onGenerationLifecycle, modes, activeMode, activeModeKey, charMentions]);

  const panelLabel = category === 'video' ? 'VIDEO GENERATION' : 'IMAGE GENERATION';
  const panelIcon = category === 'video' ? <Film className="w-3.5 h-3.5" /> : <ImageIcon className="w-3.5 h-3.5" />;
  const buttonVariant = category === 'video' ? 'video' as const : 'image' as const;
  const panelDomain = category === 'video' ? 'video' as const : 'image' as const;
  const panelTheme = genThemes[panelDomain];

  // -- Loading state --
  if (loading) {
    return (
      <GenPanel
        label={panelLabel}
        icon={panelIcon}
        onClose={onClose}
        domain={panelDomain}
      >
        <div className="flex-1 flex items-center justify-center gap-3 text-primary/60">
          <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
          <span className="text-xs font-mono tracking-wider text-emerald-400">generating</span>
        </div>
      </GenPanel>
    );
  }

  // -- Error state --
  if (error && !preview) {
    return (
      <GenPanel
        label={panelLabel}
        icon={panelIcon}
        onClose={onClose}
        domain={panelDomain}
      >
        <ErrorPage message={error} />
      </GenPanel>
    );
  }

  // -- Waiting for preview to load (brief moment before fetch starts) --
  if (!preview) {
    return (
      <GenPanel
        label={panelLabel}
        icon={panelIcon}
        onClose={onClose}
        domain={panelDomain}
      >
        <div className="flex-1 flex items-center justify-center gap-3 text-primary/60">
          <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
          <span className="text-xs font-mono tracking-wider text-emerald-400">generating</span>
        </div>
      </GenPanel>
    );
  }

  // -- Full preview form --
  const schema = selectedOption?.schema;
  const allFields = schema
    ? sortFields(
        Object.entries(schema.properties).filter(
          ([name]) => name !== 'project_slug',
        ) as [string, JSONSchemaProperty][],
      )
    : [];

  // Moded models restrict fields to the active mode and route its asset slots
  // through explicit slot metadata. Non-moded models keep the heuristic split.
  const slotParamNames = new Set<string>((activeMode?.asset_slots ?? []).map((s) => s.param));
  const fields = modeVisible ? allFields.filter(([name]) => modeVisible.has(name)) : allFields;

  const applyOverride = (name: string, s: JSONSchemaProperty): JSONSchemaProperty => {
    const ov = activeMode?.param_overrides?.[name];
    if (!ov) return s;
    return { ...s, maxItems: ov.maxItems ?? s.maxItems, description: ov.description ?? s.description };
  };

  const regularFields = fields.filter(
    ([name]) => name !== 'character_refs' && !isElementField(name) && (modes ? !slotParamNames.has(name) : !isAssetField(name)),
  );
  const assetFields = modes ? [] : fields.filter(([name]) => isAssetField(name));

  const elementIndices = new Set<number>();
  const elementSchemas = new Map<string, JSONSchemaProperty>();
  for (const [name, s] of fields) {
    const match = ELEMENT_FIELD_RE.exec(name);
    if (match) {
      elementIndices.add(parseInt(match[1], 10));
      elementSchemas.set(name, s);
    }
  }
  const sortedElementIndices = [...elementIndices].sort((a, b) => a - b);

  const assetFieldInfos = assetFields.map(([name, s]) => ({
    name,
    schema: s,
    value: formValues[name],
    required: schema?.required?.includes(name),
  }));

  const isDisabled = genState === 'submitting' || genState === 'processing' || refreshing;

  // Everything that isn't prompt-specific renders inside /settings.
  const settingsLevelWarnings = [
    ...routedWarnings.references,
    ...routedWarnings.settings,
    ...routedWarnings.general,
  ];

  return (
    <GenPanel
      label={panelLabel}
      icon={<Zap className="w-3.5 h-3.5" />}
      onClose={onClose}
      closeDisabled={isDisabled}
      domain={panelDomain}
      headerExtra={
        <button
          tabIndex={-1}
          onClick={() => {
            const willFlip = !flipped;
            setFlipped(willFlip);
            if (willFlip) fetchTranslatedPayload();
          }}
          title={flipped ? 'Back to form' : 'View JSON payload'}
          className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
        >
          <Settings className="w-3.5 h-3.5 stroke-[2.5]" />
        </button>
      }
      footer={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <ModelProviderSelector
              selectedModelKey={selectedModelKey}
              selectedProviderKey={selectedProviderKey}
              modelOptions={sortedModelOptions}
              onChange={handleModelProviderChange}
              disabled={isDisabled}
              variant={panelDomain}
            />
          </div>
          <GenerateCommandButton
            variant={buttonVariant}
            state={genState}
            pending={pendingGeneration}
            cost={cost}
            onClick={handleGenerate}
            disabled={!selectedOption || liveWarnings.length > 0 || liveMissingRequired.length > 0}
          />

        </div>
      }
    >
      <div className="flex-1 min-h-0 relative flex flex-col">
        {/* JSON flip face — only mounted when flipped so it can't clip the form */}
        {flipped && (
          <div className="absolute inset-0 overflow-clip flip-card-perspective">
            <div className="flip-card-inner w-full h-full relative flipped">
              <div className="flip-card-back absolute inset-0 flex">
                <div className="flex-1 overflow-auto pl-4 pr-2 py-4 [scrollbar-gutter:stable]">
                  <div className="font-mono text-xs font-bold tracking-widest text-emerald-400/70 mb-3">
                    /tool-call
                  </div>
                  <pre className="text-sm font-mono leading-relaxed whitespace-pre-wrap break-all select-text">
                    <JsonNode data={jsonPayload ?? {}} />
                  </pre>
                </div>
                <div className="flex-1 overflow-auto pl-4 pr-2 py-4 border-l border-primary/20 [scrollbar-gutter:stable]">
                  <div className="font-mono text-xs font-bold tracking-widest text-emerald-400/70 mb-3">
                    /provider-payload
                  </div>
                  {translateLoading ? (
                    <div className="flex items-center gap-2 text-emerald-400/40">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span className="text-[10px] font-mono">Translating...</span>
                    </div>
                  ) : translatedPayload ? (
                    <pre className="text-sm font-mono leading-relaxed whitespace-pre-wrap break-all select-text">
                      <JsonNode data={translatedPayload} />
                    </pre>
                  ) : (
                    <span className="text-[10px] text-primary/20 font-mono italic">
                      Flip to refresh
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
        {/* Form face — normal block flow (not absolute) so autofocus cannot scroll
            the /prompt header out of the top of an overflow-clip ancestor. */}
        {!flipped && (
          <div
            className={cn(
              'flex-1 min-h-0 overflow-y-auto px-3 py-2',
              refreshing && 'opacity-50 pointer-events-none transition-opacity duration-150',
            )}
          >
            {error && (
              <div className="mb-3 px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-red-400 text-xs font-mono">
                {error}
              </div>
            )}

            <div className="space-y-2">
                {regularFields.some(([name]) => name === 'prompt') && (() => {
                  const promptValue = typeof formValues.prompt === 'string' ? (formValues.prompt as string) : '';
                  const slugsRaw = formValues.image_slugs;
                  const slugsCount = Array.isArray(slugsRaw) ? slugsRaw.length : 0;
                  const rewriteDisabled = isDisabled || rewriting || (!promptValue.trim() && slugsCount === 0);
                  return (
                    <PromptSection
                      value={promptValue}
                      onChange={(v) => handleFieldChange('prompt', v)}
                      disabled={isDisabled}
                      required={schema?.required?.includes('prompt')}
                      warning={routedWarnings.prompt}
                      category={category}
                      color={category === 'video' ? 'video' : 'image'}
                      promptHistory={promptHistory}
                      callTool={callTool}
                      projectSlug={projectSlug}
                      selectedModelKey={selectedModelKey}
                      rewriteOpen={rewriteOpen}
                      setRewriteOpen={setRewriteOpen}
                      rewriting={rewriting}
                      onRewriteSubmit={handleRewritePromptSubmit}
                      rewriteDisabled={rewriteDisabled}
                      rewriteSupported={category === 'image' || VIDEO_REWRITE_MODELS.has(selectedModelKey)}
                      resolveRef={promptResolveRef}
                      characterMentions={allCharMentions}
                      characterHandles={charHandles}
                      onPickCharacter={handlePickCharacter}
                      referenceImageSlots={referenceImageSlots}
                      referenceVoiceSlots={referenceVoiceSlots}
                      assetMentions={imageAssets?.map((a) => ({ slug: a.slug, thumbnailSrc: a.thumbnailSrc }))}
                      onPickAsset={handlePickImageAsset}
                    />
                  );
                })()}
                {(assetFieldInfos.length > 0 || !!(activeMode?.asset_slots?.length) || characterPills.length > 0) && (
                  <MediaStrip
                    option={selectedOption!}
                    activeMode={activeMode}
                    formValues={formValues}
                    resolvedAssets={preview.resolved_assets ?? []}
                    droppedAssets={droppedAssets}
                    onChange={handleStripChange}
                    disabled={isDisabled}
                    domain={panelDomain}
                    characters={characterPills}
                    onRemoveCharacter={handleRemoveCharacter}
                    warnings={routedWarnings.references}
                  />
                )}
                {schema?.properties.character_refs && (
                  <CharacterPickerPopover
                    selectedRefs={characterRefs}
                    onChange={(refs) => handleFieldChange('character_refs', refs)}
                    maxItems={schema.properties.character_refs.maxItems ?? 7}
                    disabled={isDisabled}
                    callTool={callTool}
                    mcpState={mcpState}
                    projectSlug={projectSlug}
                    domain={panelDomain}
                  />
                )}
                {category === 'image' && sortedElementIndices.length > 0 && (
                  <ElementGroupEditor
                    elementGroupIndices={sortedElementIndices}
                    elementSchemas={elementSchemas}
                    formValues={formValues}
                    resolvedAssets={preview.resolved_assets}
                    droppedAssets={droppedAssets}
                    assets={[]}
                    onChange={handleFieldChange}
                    disabled={isDisabled}
                    domain={panelDomain}
                  />
                )}
                {(regularFields.filter(([name]) => name !== 'prompt').length > 0 || settingsLevelWarnings.length > 0) && (
                  <GenSection label="settings" color={panelDomain} warning={settingsLevelWarnings}>
                    {regularFields.filter(([name]) => name !== 'prompt').length > 0 && (
                      <div className="flex flex-wrap gap-x-6 gap-y-3">
                        {regularFields
                          .filter(([name]) => name !== 'prompt')
                          .map(([name, s]) => (
                            <DynamicField
                              key={name}
                              name={name}
                              schema={applyOverride(name, s)}
                              value={formValues[name]}
                              onChange={(v) => handleFieldChange(name, v)}
                              required={schema?.required?.includes(name)}
                              disabled={isDisabled}
                              theme={panelTheme}
                              callTool={callTool}
                              mcpState={mcpState}
                              projectSlug={projectSlug}
                            />
                          ))}
                      </div>
                    )}
                  </GenSection>
                )}
            </div>
          </div>
        )}
      </div>
    </GenPanel>
  );
});
