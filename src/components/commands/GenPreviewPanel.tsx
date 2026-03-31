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
import { ErrorPage } from '@/components/gen/state/ErrorPage';
import { JsonNode } from '@/components/ui/JsonNode';
import { CommandButton } from './CommandButton';
import { ELEMENT_FIELD_RE } from '@/components/gen/types';
import type { FullPreviewResponse, ModelOption, JSONSchemaProperty, ResolvedAsset } from '@/components/gen/types';
import type { ExecuteButtonState } from './types';
import type { UseMcpResult } from 'use-mcp/react';

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

interface SavedGenSettings {
  model: string;
  provider: string;
  fields: Record<string, unknown>;
}

function loadGenSettings(category: string): SavedGenSettings | null {
  try {
    const raw = localStorage.getItem(`clipfirst:gen:${category}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveGenSettings(category: string, data: SavedGenSettings): void {
  try {
    localStorage.setItem(`clipfirst:gen:${category}`, JSON.stringify(data));
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
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const formValuesRef = useRef(formValues);
  formValuesRef.current = formValues;
  const refreshIdRef = useRef(0);
  const savedRef = useRef(loadGenSettings(category));
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
      const currentPrompt = isRefresh ? formValuesRef.current.prompt : undefined;
      const prefilled = option?.prefilled_values ?? {};
      setFormValues(currentPrompt !== undefined ? { ...prefilled, prompt: currentPrompt } : prefilled);
      setDroppedAssets(new Map());
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

  const selectedOption: ModelOption | undefined = preview?.model_options.find(
    (o) => o.key === selectedModelKey,
  );

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
    return preview.model_options.filter((o) =>
      o.providers?.some((p) => p.key === selectedProviderKey),
    );
  }, [preview, selectedProviderKey]);

  const jsonPayload = useMemo(() => {
    if (!selectedOption) return null;
    return {
      tool_name: selectedOption.tool_name,
      args: { ...formValues, project_slug: projectSlug, _provider: selectedProviderKey },
    };
  }, [selectedOption, formValues, projectSlug, selectedProviderKey]);

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
      if (key !== 'prompt' && key !== 'project_slug' && !isAssetField(key) && !isElementField(key) && key in formValues) {
        fields[key] = formValues[key];
      }
    }
    saveGenSettings(category, { model: selectedModelKey, provider: selectedProviderKey, fields });
    try {
      const args: Record<string, unknown> = { ...formValues, project_slug: projectSlug, _provider: selectedProviderKey };
      const result = await callToolRef.current(selectedOption.tool_name, args);
      if (result.isError) {
        setGenState(undefined);
        const content = result.content as Array<{ type: string; text: string }>;
        setError(content[0]?.text ?? 'Generation failed');
      } else {
        setGenState('success');
        setTimeout(() => {
          onClose();
        }, 1200);
      }
    } catch (e) {
      setGenState(undefined);
      setError(e instanceof Error ? e.message : 'Generation failed');
    }
  }, [selectedOption, formValues, projectSlug, onClose, selectedProviderKey, category, selectedModelKey]);

  const panelLabel = category === 'video' ? 'VIDEO GENERATION' : 'IMAGE GENERATION';
  const panelIcon = category === 'video' ? <Film className="w-3.5 h-3.5" /> : <ImageIcon className="w-3.5 h-3.5" />;
  const buttonVariant = category === 'video' ? 'fuchsia' as const : 'blue' as const;

  // -- Loading state --
  if (loading) {
    return (
      <GenPanel
        label={panelLabel}
        icon={panelIcon}
        onClose={onClose}
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

  return (
    <GenPanel
      label={panelLabel}
      icon={<Zap className="w-3.5 h-3.5" />}
      onClose={onClose}
      closeDisabled={isDisabled}
      closeHidden
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
      headerRight={null}
      footer={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <ModelSelector
              selectedModelKey={selectedModelKey}
              modelOptions={filteredModelOptions}
              onChange={handleModelChange}
              disabled={isDisabled}
            />
            <ProviderSelector
              selectedProvider={
                preview.model_options.flatMap((o) => o.providers ?? []).find((p) => p.key === selectedProviderKey)?.label
                ?? allProviderLabels[0]
              }
              providers={allProviderLabels}
              onChange={handleProviderChange}
              disabled={isDisabled}
            />
          </div>
          <CommandButton
            command="/generate"
            icon={<Zap className="w-3.5 h-3.5" />}
            variant={buttonVariant}
            state={genState}
            onClick={handleGenerate}
            disabled={!selectedOption}
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
              <pre className="text-sm font-mono leading-relaxed whitespace-pre-wrap break-all">
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
                <pre className="text-sm font-mono leading-relaxed whitespace-pre-wrap break-all">
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

            {/* Warnings */}
            {selectedOption?.validation.warnings && selectedOption.validation.warnings.length > 0 && (
              <div className="mb-3 space-y-1">
                {selectedOption.validation.warnings.map((w, i) => (
                  <div key={i} className="px-3 py-1.5 rounded border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 text-[10px] font-mono">
                    {w}
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              {/* Left column: prompt + inline params */}
              <div className="flex-1 space-y-2">
                {/* Prompt field in /prompt section */}
                {regularFields
                  .filter(([name]) => name === 'prompt')
                  .map(([name]) => (
                    <div key={name} className="rounded border border-emerald-500/15 bg-emerald-500/[0.03]">
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-t border-b border-emerald-500/30 bg-emerald-500/15">
                        <span className="font-mono font-bold text-xs tracking-widest text-emerald-400">/prompt</span>
                        {schema?.required?.includes(name) && (
                          <span className="ml-auto text-[8px] font-bold text-emerald-400/60 tracking-wider">*REQ</span>
                        )}
                      </div>
                      <div className="px-3 py-2.5">
                        <textarea
                          value={typeof formValues[name] === 'string' ? (formValues[name] as string).replace(/\\n/g, '\n') : ''}
                          onChange={(e) => handleFieldChange(name, e.target.value)}
                          disabled={isDisabled}
                          autoFocus
                          rows={12}
                          className="w-full px-3 py-2 resize-none bg-black/60 border border-emerald-500/15 rounded text-emerald-200 placeholder:text-emerald-400/30 font-mono text-sm leading-relaxed focus:outline-none focus:border-emerald-400/40 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                      </div>
                    </div>
                  ))}
                {/* Other fields in /settings section */}
                {regularFields.filter(([name]) => name !== 'prompt').length > 0 && (
                  <div className="rounded border border-cyan-500/15 bg-cyan-500/[0.03]">
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-t border-b border-cyan-500/30 bg-cyan-500/15">
                      <span className="font-mono font-bold text-xs tracking-widest text-cyan-400">/settings</span>
                    </div>
                    <div className="px-3 py-2.5">
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
                            />
                          ))}
                      </div>
                    </div>
                  </div>
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
