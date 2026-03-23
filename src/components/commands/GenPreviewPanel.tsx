import { useState, useCallback, useEffect, useRef } from 'react';
import { Zap, Loader2, Film, ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GenPanel } from '@/components/gen/ui/GenPanel';
import { ModelSelector } from '@/components/gen/ui/ModelSelector';
import { DynamicField } from '@/components/gen/ui/DynamicField';
import { ImageParamSlots } from '@/components/gen/ImageParamSlots';
import { ElementGroupEditor } from '@/components/gen/ElementGroupEditor';
import { sortFields, isAssetField, isElementField } from '@/components/gen/ui/fieldHelpers';
import { ErrorPage } from '@/components/gen/state/ErrorPage';
import { CommandButton } from './CommandButton';
import { ELEMENT_FIELD_RE } from '@/components/gen/types';
import type { FullPreviewResponse, ModelOption, JSONSchemaProperty, ResolvedAsset } from '@/components/gen/types';
import type { ExecuteButtonState } from './types';
import type { UseMcpResult } from 'use-mcp/react';

type GenCategory = 'video' | 'image' | 'auto';

interface GenPreviewPanelProps {
  category: GenCategory;
  prompt: string;
  onClose: () => void;
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

function getPreviewToolName(cat: 'video' | 'image'): string {
  return cat === 'video' ? 'preview_video_gen' : 'preview_image_gen';
}

export function GenPreviewPanel({
  category,
  prompt: initialPrompt,
  onClose,
  callTool,
  projectSlug,
}: GenPreviewPanelProps) {
  const [activeCategory, setActiveCategory] = useState<'video' | 'image' | null>(
    category !== 'auto' ? category : null,
  );
  const promptText = initialPrompt;
  const [preview, setPreview] = useState<FullPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [droppedAssets, setDroppedAssets] = useState<Map<string, ResolvedAsset>>(new Map());
  const [genState, setGenState] = useState<ExecuteButtonState | undefined>(undefined);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;

  const fetchPreview = useCallback(async (cat: 'video' | 'image', prompt: string) => {
    if (!projectSlug) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const result = await callToolRef.current(getPreviewToolName(cat), {
        prompt,
        project_slug: projectSlug,
      });
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
      setFormValues(option?.prefilled_values ?? {});
      setDroppedAssets(new Map());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  }, [projectSlug]);

  // Auto-fetch when category is known
  const hasFetched = useRef(false);
  useEffect(() => {
    if (hasFetched.current) return;
    if (activeCategory) {
      hasFetched.current = true;
      fetchPreview(activeCategory, initialPrompt);
    }
  }, [activeCategory, initialPrompt, fetchPreview]);

  const handleCategorySelect = useCallback((cat: 'video' | 'image') => {
    setActiveCategory(cat);
    fetchPreview(cat, promptText);
  }, [promptText, fetchPreview]);

  const handleModelChange = useCallback((modelKey: string) => {
    setSelectedModelKey(modelKey);
    const option = preview?.model_options.find((o) => o.key === modelKey);
    if (option) {
      const currentPrompt = formValues.prompt;
      setFormValues({ ...option.prefilled_values, prompt: currentPrompt });
      setDroppedAssets(new Map());
    }
  }, [preview, formValues.prompt]);

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

  const handleGenerate = useCallback(async () => {
    if (!selectedOption || !projectSlug) return;
    setGenState('submitting');
    try {
      const args: Record<string, unknown> = { ...formValues, project_slug: projectSlug };
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
  }, [selectedOption, formValues, projectSlug, onClose]);

  // -- Category picker (auto mode, no category selected yet) --
  if (!activeCategory) {
    return (
      <GenPanel
        label="GENERATE"
        icon={<Zap className="w-4 h-4" />}
        onClose={onClose}
      >
        <div className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
          <span className="text-xs font-bold tracking-[0.15em] text-primary/50 uppercase">
            Choose type
          </span>
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => handleCategorySelect('video')}
              className={cn(
                'flex flex-col items-center gap-3 px-8 py-6 rounded border-2',
                'border-primary/30 bg-black/40 text-primary/70',
                'hover:border-primary hover:text-primary hover:bg-primary/10',
                'transition-all duration-200',
                'focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:outline-none',
              )}
            >
              <Film className="w-8 h-8" />
              <span className="text-xs font-bold tracking-[0.15em] uppercase">Video</span>
            </button>
            <button
              type="button"
              onClick={() => handleCategorySelect('image')}
              className={cn(
                'flex flex-col items-center gap-3 px-8 py-6 rounded border-2',
                'border-primary/30 bg-black/40 text-primary/70',
                'hover:border-primary hover:text-primary hover:bg-primary/10',
                'transition-all duration-200',
                'focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:outline-none',
              )}
            >
              <ImageIcon className="w-8 h-8" />
              <span className="text-xs font-bold tracking-[0.15em] uppercase">Image</span>
            </button>
          </div>
          {promptText && (
            <p className="text-[10px] text-primary/40 font-mono max-w-sm truncate">
              prompt: {promptText}
            </p>
          )}
        </div>
      </GenPanel>
    );
  }

  // -- Loading state --
  if (loading) {
    return (
      <GenPanel
        label={activeCategory === 'video' ? 'VIDEO GEN' : 'IMAGE GEN'}
        icon={<Zap className="w-4 h-4" />}
        onClose={onClose}
      >
        <div className="flex-1 flex items-center justify-center gap-3 text-primary/60">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-xs font-mono tracking-wider">Routing prompt...</span>
        </div>
      </GenPanel>
    );
  }

  // -- Error state --
  if (error && !preview) {
    return (
      <GenPanel
        label={activeCategory === 'video' ? 'VIDEO GEN' : 'IMAGE GEN'}
        icon={<Zap className="w-4 h-4" />}
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
        label={activeCategory === 'video' ? 'VIDEO GEN' : 'IMAGE GEN'}
        icon={<Zap className="w-4 h-4" />}
        onClose={onClose}
      >
        <div className="flex-1 flex items-center justify-center gap-3 text-primary/60">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-xs font-mono tracking-wider">Loading...</span>
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

  return (
    <GenPanel
      label={activeCategory === 'video' ? 'VIDEO GEN' : 'IMAGE GEN'}
      icon={<Zap className="w-4 h-4" />}
      onClose={onClose}
      closeDisabled={genState === 'submitting' || genState === 'processing'}
      footer={
        <div className="flex items-center justify-between">
          <ModelSelector
            selectedModelKey={selectedModelKey}
            modelOptions={preview.model_options}
            onChange={handleModelChange}
            disabled={genState === 'submitting' || genState === 'processing'}
          />
          <CommandButton
            command="/generate"
            icon={<Zap className="w-4 h-4" />}
            size="lg"
            state={genState}
            onClick={handleGenerate}
            disabled={!selectedOption}
          />
        </div>
      }
    >
      <div className="flex-1 overflow-y-auto p-4">
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

        <div className="flex gap-4">
          {/* Left column: regular fields */}
          <div className="flex-1 space-y-4">
            {regularFields.map(([name, s]) => (
              <DynamicField
                key={name}
                name={name}
                schema={s}
                value={formValues[name]}
                onChange={(v) => handleFieldChange(name, v)}
                required={schema?.required?.includes(name)}
                disabled={genState === 'submitting' || genState === 'processing'}
                autoFocus={name === 'prompt'}
              />
            ))}
          </div>

          {/* Right column: asset slots + element groups */}
          {(assetFieldInfos.length > 0 || sortedElementIndices.length > 0) && (
            <div className="w-48 shrink-0 space-y-4">
              {assetFieldInfos.length > 0 && (
                <ImageParamSlots
                  assetFields={assetFieldInfos}
                  resolvedAssets={preview.resolved_assets}
                  droppedAssets={droppedAssets}
                  imageSlots={imageSlots}
                  onChange={handleFieldChange}
                  disabled={genState === 'submitting' || genState === 'processing'}
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
                  disabled={genState === 'submitting' || genState === 'processing'}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </GenPanel>
  );
}
