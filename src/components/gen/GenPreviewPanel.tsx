import { useState, useCallback, useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { Zap, Loader2, Settings, ImageIcon, Film } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMountKey } from '@/contexts/MountKeyContext';
import { GenPanel } from '@/components/gen/ui/GenPanel';
import { ModelSelector, ProviderSelector } from '@/components/gen/ui/ModelSelector';
import { DynamicField } from '@/components/gen/ui/DynamicField';
import { ImageParamSlots } from '@/components/gen/ImageParamSlots';
import { ElementGroupEditor } from '@/components/gen/ElementGroupEditor';
import { sortFields, isAssetField, isElementField } from '@/components/gen/ui/fieldHelpers';
import { stripSlugPrefix } from '@/lib/slugs';
import { ErrorPage } from '@/components/gen/state/ErrorPage';
import { JsonNode } from '@/components/ui/JsonNode';
import { ELEMENT_FIELD_RE } from '@/components/gen/types';
import type { FullPreviewResponse, ModelOption, JSONSchemaProperty, ResolvedAsset } from '@/components/gen/types';
import type { ExecuteButtonState } from '@/components/commands/types';
import type { UseMcpResult } from 'use-mcp/react';
import { useRewriteImagePrompt, type ImagePromptGuideModel } from '@/hooks/useRewriteImagePrompt';
import { useEstimateCost, type EstimateCall } from '@/hooks/useEstimateCost';
import { GenerateCommandButton } from '@/components/gen/GenerateCommandButton';
import { usePromptHistory } from '@/hooks/usePromptHistory';
import { GenSection } from '@/components/gen/ui/GenSection';
import { PromptSection } from '@/components/gen/ui/PromptSection';
import { genThemes } from '@/components/gen/ui/gen-themes';

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
  projectSlug: string | undefined;
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

interface SavedGenSettings {
  model: string;
  provider: string;
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
  projectSlug,
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
      const seededPrompt = currentPrompt
        ?? (prefilled as { prompt?: unknown }).prompt
        ?? prompt
        ?? '';
      const preservedSlugFields: Record<string, unknown> = {};
      if (isRefresh) {
        for (const [k, v] of Object.entries(currentValues)) {
          if (isAssetField(k) || /^element\d+_slugs$/.test(k)) {
            preservedSlugFields[k] = v;
          }
        }
      }
      setFormValues({ ...prefilled, ...preservedSlugFields, prompt: seededPrompt });
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

  const handleModelChange = useCallback((modelKey: string) => {
    setSelectedModelKey(modelKey);
    fetchPreview(category, initialPrompt, {
      selected_model: modelKey,
      selected_provider: selectedProviderKey || undefined,
    });
  }, [category, initialPrompt, selectedProviderKey, fetchPreview]);

  const handleProviderChange = useCallback((label: string) => {
    const allProviders = preview?.model_options.flatMap((o) => o.providers ?? []) ?? [];
    const match = allProviders.find((p) => p.label === label);
    if (!match) return;
    setSelectedProviderKey(match.key);
    setGenState(undefined);
    setFlipped(false);
    setTranslatedPayload(null);
    setTranslateLoading(false);
    fetchPreview(category, initialPrompt, {
      selected_model: selectedModelKey || undefined,
      selected_provider: match.key,
    });
  }, [category, initialPrompt, preview, selectedModelKey, fetchPreview]);

  useImperativeHandle(ref, () => ({
    setField: (name: string, value: string) => {
      setFormValues((prev) => ({ ...prev, [name]: value }));
    },
    setModel: (key: string) => {
      handleModelChange(key);
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
  }), [handleModelChange]);

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

  const handleRewriteImagePromptSubmit = useCallback(async (
    submit: { platform?: 'ig' | 'tiktok' | 'youtube'; customPrompt?: string },
  ) => {
    if (!projectSlug) return;
    const currentValues = formValuesRef.current;
    const currentPrompt = typeof currentValues.prompt === 'string' ? currentValues.prompt : '';
    const rawSlugs = currentValues.image_slugs;
    const currentImageSlugs = Array.isArray(rawSlugs)
      ? (rawSlugs as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const rewritten = await rewriteImagePrompt({
      prompt: currentPrompt,
      model: guideModelFor(selectedModelKey),
      imageSlugs: currentImageSlugs,
      platform: submit.platform,
      customPrompt: submit.customPrompt,
      projectSlug,
    });
    if (rewritten) {
      setFormValues((prev) => ({ ...prev, prompt: rewritten }));
      setRewriteOpen(false);
    }
  }, [projectSlug, selectedModelKey, rewriteImagePrompt]);

  const selectedOption: ModelOption | undefined = preview?.model_options.find(
    (o) => o.key === selectedModelKey,
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
      isAssetField(name) || /^element\d+_slugs$/.test(name);

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
  }, [preview, droppedAssets, selectedOption]);

  // Global provider list (union across all models) and models filtered by selected provider
  const allProviderLabels = useMemo(() => {
    if (!preview) return ['Kie'];
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const opt of preview.model_options) {
      for (const p of opt.providers ?? []) {
        if (!seen.has(p.key)) {
          seen.add(p.key);
          labels.push(p.label);
        }
      }
    }
    return labels.length > 0 ? labels : ['Kie'];
  }, [preview]);

  const filteredModelOptions = useMemo(() => {
    if (!preview) return [];
    return preview.model_options
      .filter((o) => o.providers?.some((p) => p.key === selectedProviderKey))
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [preview, selectedProviderKey]);

  const jsonPayload = useMemo(() => {
    if (!selectedOption) return null;
    return {
      tool_name: selectedOption.tool_name,
      args: { ...formValues, project_slug: projectSlug, _provider: selectedProviderKey },
    };
  }, [selectedOption, formValues, projectSlug, selectedProviderKey]);

  const estimateCalls = useMemo<EstimateCall[] | null>(() => {
    if (!selectedOption) return null;
    // project_slug lets the server resolve duration-priced models like
    // kling-3.0/motion-control where the billable seconds come from the input
    // motion video, not a user-typed parameter.
    const input: Record<string, unknown> = projectSlug
      ? { ...formValues, project_slug: projectSlug }
      : formValues;
    return [{ toolName: selectedOption.tool_name, input }];
  }, [selectedOption, formValues, projectSlug]);
  const cost = useEstimateCost(callTool, { calls: estimateCalls });

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
    return warnings;
  }, [selectedOption?.tool_name, formValues.first_clip_slug, formValues.first_frame_slug, formValues.last_frame_slug, formValues.audio_slugs]);

  // Live required-field check derived from current form values. The server
  // computes validation.missing_required once at preview time; this recomputes
  // against the latest formValues so disabling tracks user input live.
  const liveMissingRequired = useMemo(() => {
    const required = selectedOption?.schema.required ?? [];
    const missing: string[] = [];
    for (const name of required) {
      if (name === 'project_slug') continue;
      const v = formValues[name];
      if (v === undefined || v === null || v === '') missing.push(name);
      else if (Array.isArray(v) && v.length === 0) missing.push(name);
    }
    return missing;
  }, [selectedOption?.schema.required, formValues]);

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
      const args: Record<string, unknown> = { ...formValues, project_slug: projectSlug, _provider: selectedProviderKey };
      const result = await callToolRef.current(selectedOption.tool_name, args);
      if (result.isError) {
        setGenState(undefined);
        const content = result.content as Array<{ type: string; text: string }>;
        setError(content[0]?.text ?? 'Generation failed');
      } else {
        const submittedPrompt = typeof formValues.prompt === 'string' ? formValues.prompt : '';
        if (submittedPrompt.trim()) {
          promptHistory.push(submittedPrompt, {
            model: selectedModelKey,
            provider: selectedProviderKey,
          });
        }
        setGenState('success');
        setTimeout(() => {
          setGenState(undefined);
        }, 1200);
      }
    } catch (e) {
      setGenState(undefined);
      setError(e instanceof Error ? e.message : 'Generation failed');
    }
  }, [selectedOption, formValues, projectSlug, selectedProviderKey, category, selectedModelKey, droppedAssets, promptHistory]);

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
  const fields = schema
    ? sortFields(
        Object.entries(schema.properties).filter(
          ([name]) => name !== 'project_slug',
        ) as [string, JSONSchemaProperty][],
      )
    : [];

  const regularFields = fields.filter(([name]) => !isAssetField(name) && !isElementField(name));
  const assetFields = fields.filter(([name]) => isAssetField(name));
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

  const imageSlots = selectedOption?.validation.image_slots ?? null;

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
            <ModelSelector
              selectedModelKey={selectedModelKey}
              modelOptions={filteredModelOptions}
              onChange={handleModelChange}
              disabled={isDisabled}
              variant={panelDomain}
            />
            <ProviderSelector
              selectedProvider={
                preview.model_options.flatMap((o) => o.providers ?? []).find((p) => p.key === selectedProviderKey)?.label
                ?? allProviderLabels[0]
              }
              providers={allProviderLabels}
              onChange={handleProviderChange}
              disabled={isDisabled}
              variant={panelDomain}
            />
          </div>
          <GenerateCommandButton
            variant={buttonVariant}
            state={genState}
            cost={cost}
            onClick={handleGenerate}
            disabled={!selectedOption || liveWarnings.length > 0 || liveMissingRequired.length > 0}
          />

        </div>
      }
    >
      <div className="flex-1 min-h-0 overflow-clip flip-card-perspective relative">
        <div className={cn('flip-card-inner w-full h-full relative', flipped && 'flipped')}>
          {/* Empty front placeholder for flip animation */}
          <div className="flip-card-face absolute inset-0" />
          {/* BACK FACE — JSON payloads side by side */}
          <div className="flip-card-back absolute inset-0 flex">
            {/* Left pane: Raw MCP tool call */}
            <div className="flex-1 overflow-auto pl-4 pr-2 py-4 [scrollbar-gutter:stable]">
              <div className="font-mono text-xs font-bold tracking-widest text-emerald-400/70 mb-3">
                /tool-call
              </div>
              <pre className="text-sm font-mono leading-relaxed whitespace-pre-wrap break-all select-text">
                <JsonNode data={jsonPayload ?? {}} />
              </pre>
            </div>

            {/* Right pane: Translated provider payload */}
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
        {/* FRONT FACE — form (outside 3D context so WebKit scroll works) */}
        {!flipped && <div className={cn('absolute inset-0 overflow-y-auto px-3 py-2', refreshing && 'opacity-50 pointer-events-none transition-opacity duration-150')}>
            {error && (
              <div className="mb-3 px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-red-400 text-xs font-mono">
                {error}
              </div>
            )}

            <div className="flex gap-2">
              {/* Left column: prompt + inline params */}
              <div className="flex-1 space-y-2">
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
                      onRewriteSubmit={handleRewriteImagePromptSubmit}
                      rewriteDisabled={rewriteDisabled}
                    />
                  );
                })()}
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
                              schema={s}
                              value={formValues[name]}
                              onChange={(v) => handleFieldChange(name, v)}
                              required={schema?.required?.includes(name)}
                              disabled={isDisabled}
                              theme={panelTheme}
                            />
                          ))}
                      </div>
                    )}
                  </GenSection>
                )}
              </div>

              {/* Right column: asset slots + element groups */}
              {(assetFieldInfos.length > 0 || sortedElementIndices.length > 0) && (
                <div className="w-56 shrink-0 space-y-2">
                  {assetFieldInfos.length > 0 && (
                    <ImageParamSlots
                      assetFields={assetFieldInfos}
                      resolvedAssets={preview.resolved_assets}
                      droppedAssets={droppedAssets}
                      imageSlots={imageSlots}
                      onChange={handleFieldChange}
                      disabled={isDisabled}
                      modelKey={selectedModelKey}
                      domain={panelDomain}
                    />
                  )}
                  {sortedElementIndices.length > 0 && (
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
                </div>
              )}
            </div>
        </div>}
      </div>
    </GenPanel>
  );
});
