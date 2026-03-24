import { GenField, GenTextarea } from '@/components/ui/GenField';
import { GenToggle } from '@/components/ui/GenToggle';
import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import { CommandDropdown } from '@/components/commands/CommandDropdown';
import type { JSONSchemaProperty, VeoGenerationType } from '../types';
import { cn } from '@/lib/utils';

interface DynamicFieldProps {
  name: string;
  schema: JSONSchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  required?: boolean;
  disabled?: boolean;
  labelOverride?: string;
  placeholderOverride?: string;
  autoFocus?: boolean;
}

// Convert field name to display label
function formatLabel(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Locked field component for single-value enums
function LockedField({
  label,
  value,
  required,
}: {
  label: string;
  value: string;
  required?: boolean;
}): React.ReactElement {
  return (
    <GenField label={label} required={required}>
      <div className="inline-flex items-center gap-2">
        <GenToggle value={value} onChange={() => {}} options={[value] as readonly string[]} disabled={true} />
        <span className="text-[10px] font-mono text-yellow-400/60 uppercase tracking-wider">LOCKED</span>
      </div>
    </GenField>
  );
}

export function DynamicField({
  name,
  schema,
  value,
  onChange,
  required,
  disabled,
  labelOverride,
  placeholderOverride,
  autoFocus,
}: DynamicFieldProps) {
  const label = labelOverride || formatLabel(name);

  // Handle array types (image_slugs) - render as AssetDropSlot for string arrays
  if (schema.type === 'array') {
    if (schema.items?.type === 'string' || !schema.items?.type) {
      const slug = Array.isArray(value) && value.length > 0 ? String(value[0]) : null;

      return (
        <AssetDropSlot
          value={slug ? { slug, src: '', type: 'image' as const } : null}
          onChange={(asset) => {
            onChange(asset ? [asset.slug] : []);
          }}
          disabled={disabled}
          acceptTypes={['image']}
        />
      );
    }

    return null;
  }

  // Special handling for generation_type field - render as prominent mode selector
  if (name === 'generation_type' && schema.type === 'string' && schema.enum) {
    const options = schema.enum as VeoGenerationType[];
    const currentValue = (value ?? schema.default) as VeoGenerationType;

    const modeLabels: Record<VeoGenerationType, { short: string; description: string }> = {
      TEXT_2_VIDEO: { short: 'Text', description: 'Generate from text prompt only' },
      FIRST_AND_LAST_FRAMES_2_VIDEO: { short: 'Keyframes', description: 'Generate from first/last frame images' },
      REFERENCE_2_VIDEO: { short: 'Reference', description: 'Generate using reference images (veo3_fast only)' },
    };

    return (
      <div className="space-y-2">
        <label className="text-xs font-mono font-bold tracking-widest text-primary/70">Generation Mode</label>
        <div className="flex gap-2">
          {options.map((mode) => {
            const isSelected = currentValue === mode;
            const modeInfo = modeLabels[mode];
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onChange(mode)}
                disabled={disabled}
                title={modeInfo.description}
                className={cn(
                  'flex-1 px-3 py-2 rounded border text-xs font-mono transition-all',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:outline-none',
                  isSelected
                    ? 'bg-primary/20 border-primary text-primary'
                    : 'bg-black/40 border-primary/30 text-primary/60 hover:border-primary/50 hover:text-primary/80'
                )}
              >
                {modeInfo.short}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-zinc-500 font-mono">{modeLabels[currentValue]?.description}</p>
      </div>
    );
  }

  // Special handling for 'model' field - always show both veo3 options, never locked
  if (name === 'model' && schema.type === 'string' && schema.enum) {
    const options = ['veo3_fast', 'veo3'];
    const effectiveValue = (value ?? schema.default ?? options[0]) as string;

    return (
      <GenField label={label} required={required}>
        <GenToggle
          value={effectiveValue}
          onChange={(v) => onChange(v)}
          options={options as readonly string[]}
          disabled={disabled}
        />
      </GenField>
    );
  }

  // Handle string type with enum (2-4 items = toggle, 5+ items = select)
  if (schema.type === 'string' && schema.enum) {
    const options = schema.enum as string[];

    if (options.length === 1) {
      return <LockedField label={label} value={options[0]} required={required} />;
    }

    const effectiveValue = (value ?? schema.default) as string;

    if (options.length >= 2 && options.length <= 4) {
      return (
        <GenField label={label} required={required}>
          <GenToggle
            value={effectiveValue}
            onChange={(v) => onChange(v)}
            options={options as readonly string[]}
            disabled={disabled}
          />
        </GenField>
      );
    }

    return (
      <CommandDropdown
        command={"/" + name}
        value={effectiveValue}
        options={options.map((opt) => ({ value: opt, label: opt }))}
        onChange={(v) => onChange(v)}
        disabled={disabled}
      />
    );
  }

  // Handle integer/number type with enum - use toggle or select
  if ((schema.type === 'integer' || schema.type === 'number') && schema.enum) {
    const options = schema.enum.map(String);
    const effectiveValue = value != null ? String(value) : schema.default != null ? String(schema.default) : '';

    if (options.length === 1) {
      return <LockedField label={label} value={options[0]} required={required} />;
    }

    if (options.length >= 2 && options.length <= 6) {
      return (
        <GenField label={label} required={required}>
          <GenToggle
            value={effectiveValue}
            onChange={(v) => onChange(schema.type === 'integer' ? parseInt(v, 10) : parseFloat(v))}
            options={options as readonly string[]}
            disabled={disabled}
          />
        </GenField>
      );
    }

    return (
      <CommandDropdown
        command={"/" + name}
        value={effectiveValue}
        options={options.map((opt) => ({ value: opt, label: opt }))}
        onChange={(v) => onChange(schema.type === 'integer' ? parseInt(v, 10) : parseFloat(v))}
        disabled={disabled}
      />
    );
  }

  // Handle integer/number type without enum - use number input
  if (schema.type === 'integer' || schema.type === 'number') {
    return (
      <GenField label={label} required={required}>
        <input
          type="number"
          value={value !== undefined && value !== null ? String(value) : ''}
          onChange={(e) => {
            const val = e.target.value;
            if (val === '') {
              onChange(undefined);
            } else {
              onChange(schema.type === 'integer' ? parseInt(val, 10) : parseFloat(val));
            }
          }}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.type === 'integer' ? 1 : 'any'}
          placeholder={schema.description || `Enter ${label.toLowerCase()}...`}
          disabled={disabled}
          className="w-full px-3 py-2 bg-black/60 border border-primary/30 rounded text-primary/90 font-mono text-sm placeholder:text-primary/30 focus:outline-none focus:border-primary/60 disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </GenField>
    );
  }

  // Handle boolean type - use toggle with Yes/No
  if (schema.type === 'boolean') {
    return (
      <GenField label={label} required={required}>
        <GenToggle
          value={value === true ? 'Yes' : 'No'}
          onChange={(v) => onChange(v === 'Yes')}
          options={['No', 'Yes'] as const}
          disabled={disabled}
        />
      </GenField>
    );
  }

  // Handle plain string type (no enum) - use textarea
  if (schema.type === 'string') {
    // image_slug field should use AssetDropSlot
    if (name === 'image_slug') {
      const slug = value as string;
      return (
        <AssetDropSlot
          value={slug ? { slug, src: '', type: 'image' as const } : null}
          onChange={(asset) => {
            onChange(asset ? asset.slug : '');
          }}
          disabled={disabled}
          acceptTypes={['image']}
        />
      );
    }

    // video_slug field should use AssetDropSlot
    if (name === 'video_slug') {
      const slug = value as string;
      return (
        <AssetDropSlot
          value={slug ? { slug, src: '', type: 'video' as const } : null}
          onChange={(asset) => {
            onChange(asset ? asset.slug : '');
          }}
          disabled={disabled}
          acceptTypes={['video']}
        />
      );
    }

    // Regular text input
    const isPrompt = name === 'prompt';
    const placeholder = placeholderOverride || schema.description || `Enter ${label.toLowerCase()}...`;
    return (
      <GenField label={label} required={required}>
        <GenTextarea
          value={(value as string) || ''}
          onChange={(v) => onChange(v)}
          placeholder={placeholder}
          disabled={disabled}
          rows={isPrompt ? 12 : 2}
          autoFocus={autoFocus}
        />
      </GenField>
    );
  }

  // Fallback for unknown types
  return (
    <GenField label={label} required={required}>
      <div className="text-xs text-red-400/70 font-mono">Unsupported field type: {schema.type}</div>
    </GenField>
  );
}

