import { GenField, GenTextarea } from '@/components/ui/GenField';
import { GenToggle } from '@/components/ui/GenToggle';
import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import type { JSONSchemaProperty } from '../types';
import type { GenTheme } from './gen-themes';
import { genThemes } from './gen-themes';
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
  theme?: GenTheme;
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
  theme,
}: {
  label: string;
  value: string;
  required?: boolean;
  theme?: GenTheme;
}): React.ReactElement {
  return (
    <GenField label={label} required={required} theme={theme} horizontal>
      <div className="inline-flex items-center gap-2">
        <GenToggle value={value} onChange={() => {}} options={[value] as readonly string[]} disabled={true} theme={theme} />
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
  theme,
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

  // Handle string type with enum (2-4 items = toggle, 5+ items = dropdown)
  if (schema.type === 'string' && schema.enum) {
    const options = schema.enum as string[];

    if (options.length === 1) {
      return <LockedField label={label} value={options[0]} required={required} theme={theme} />;
    }

    const effectiveValue = (value ?? schema.default) as string;

    if (options.length >= 2 && options.length <= 4) {
      return (
        <GenField label={label} required={required} theme={theme} horizontal>
          <GenToggle
            value={effectiveValue}
            onChange={(v) => onChange(v)}
            options={options as readonly string[]}
            disabled={disabled}
            theme={theme}
          />
        </GenField>
      );
    }

    return (
      <GenField label={label} required={required} theme={theme} horizontal>
        <select
          value={effectiveValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={cn(
            'px-3 py-1.5 bg-black/60 rounded font-mono text-sm appearance-none cursor-pointer',
            theme ? cn(theme.controlBorder, 'border', theme.valueText) : 'border border-primary/30 text-primary/90',
            'focus:outline-none focus:border-primary/60',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </GenField>
    );
  }

  // Handle integer/number type with enum - use toggle or dropdown
  if ((schema.type === 'integer' || schema.type === 'number') && schema.enum) {
    const options = schema.enum.map(String);
    const effectiveValue = value != null ? String(value) : schema.default != null ? String(schema.default) : '';

    if (options.length === 1) {
      return <LockedField label={label} value={options[0]} required={required} theme={theme} />;
    }

    if (options.length >= 2 && options.length <= 6) {
      return (
        <GenField label={label} required={required} theme={theme} horizontal>
          <GenToggle
            value={effectiveValue}
            onChange={(v) => onChange(schema.type === 'integer' ? parseInt(v, 10) : parseFloat(v))}
            options={options as readonly string[]}
            disabled={disabled}
            theme={theme}
          />
        </GenField>
      );
    }

    return (
      <GenField label={label} required={required} theme={theme} horizontal>
        <select
          value={effectiveValue}
          onChange={(e) => {
            const v = e.target.value;
            onChange(schema.type === 'integer' ? parseInt(v, 10) : parseFloat(v));
          }}
          disabled={disabled}
          className={cn(
            'px-3 py-1.5 bg-black/60 rounded font-mono text-sm appearance-none cursor-pointer',
            theme ? cn(theme.controlBorder, 'border', theme.valueText) : 'border border-primary/30 text-primary/90',
            'focus:outline-none focus:border-primary/60',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </GenField>
    );
  }

  // Handle integer/number type without enum - use slider when bounded, number input otherwise
  if (schema.type === 'integer' || schema.type === 'number') {
    const isInteger = schema.type === 'integer';
    const parseValue = (v: string) => (isInteger ? parseInt(v, 10) : parseFloat(v));
    const hasRange = schema.minimum !== undefined && schema.maximum !== undefined;

    if (hasRange) {
      const current = value !== undefined && value !== null
        ? Number(value)
        : schema.default !== undefined ? Number(schema.default) : schema.minimum!;
      const step = isInteger ? 1 : 'any';
      const clamp = (n: number) => Math.min(schema.maximum!, Math.max(schema.minimum!, n));

      return (
        <GenField label={label} required={required} theme={theme} horizontal>
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <input
              type="range"
              value={current}
              onChange={(e) => onChange(parseValue(e.target.value))}
              min={schema.minimum}
              max={schema.maximum}
              step={step}
              disabled={disabled}
              className={cn(
                'flex-1 min-w-[120px] h-1 cursor-pointer appearance-none bg-transparent',
                '[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-primary/20',
                '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer',
                '[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-primary/20',
                '[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            />
            <input
              type="number"
              value={current}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '') return;
                const n = parseValue(v);
                if (Number.isNaN(n)) return;
                onChange(n);
              }}
              onBlur={(e) => {
                const v = e.target.value;
                if (v === '') { onChange(schema.minimum); return; }
                const n = parseValue(v);
                if (Number.isNaN(n)) { onChange(schema.minimum); return; }
                onChange(clamp(n));
              }}
              min={schema.minimum}
              max={schema.maximum}
              step={step}
              disabled={disabled}
              className={cn(
                'w-16 px-2 py-1 bg-black/60 rounded font-mono text-sm text-right tabular-nums shrink-0',
                theme ? cn(theme.controlBorder, 'border', theme.valueText) : 'border border-primary/30 text-primary/90',
                'focus:outline-none focus:border-primary/60',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            />
          </div>
        </GenField>
      );
    }

    return (
      <GenField label={label} required={required} theme={theme} horizontal>
        <input
          type="number"
          value={value !== undefined && value !== null ? String(value) : ''}
          onChange={(e) => {
            const val = e.target.value;
            if (val === '') {
              onChange(undefined);
            } else {
              onChange(parseValue(val));
            }
          }}
          min={schema.minimum}
          max={schema.maximum}
          step={isInteger ? 1 : 'any'}
          placeholder={schema.description || `Enter ${label.toLowerCase()}...`}
          disabled={disabled}
          className={cn(
            'w-24 px-3 py-1.5 bg-black/60 rounded font-mono text-sm text-right tabular-nums',
            theme ? cn(theme.controlBorder, 'border', theme.valueText) : 'border border-primary/30 text-primary/90',
            'placeholder:text-primary/30 focus:outline-none focus:border-primary/60',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        />
      </GenField>
    );
  }

  // Handle boolean type - use toggle with Yes/No
  if (schema.type === 'boolean') {
    return (
      <GenField label={label} required={required} theme={theme} horizontal>
        <GenToggle
          value={value === true ? 'Yes' : 'No'}
          onChange={(v) => onChange(v === 'Yes')}
          options={['No', 'Yes'] as const}
          disabled={disabled}
          theme={theme}
        />
      </GenField>
    );
  }

  // Handle plain string type (no enum) - use textarea
  if (schema.type === 'string') {
    // size field: preset aspect ratios + free-text override
    if (name === 'size') {
      const presets: { ratio: string; dims: string; value: string }[] = [
        { ratio: '9:16', dims: '1080×1920', value: '1080*1920' },
        { ratio: '16:9', dims: '1920×1080', value: '1920*1080' },
        { ratio: '1:1', dims: '1080×1080', value: '1080*1080' },
      ];
      const current = (value as string) ?? '';
      const t = theme ?? genThemes.cyan;
      return (
        <GenField label={label} required={required} theme={theme} horizontal>
          <div className="flex items-center gap-1.5">
            {presets.map((p) => {
              const active = current === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => !disabled && onChange(p.value)}
                  disabled={disabled}
                  className={cn(
                    'h-8 px-3 rounded font-mono font-bold text-xs tracking-wider border transition-all duration-150',
                    active
                      ? cn(t.activeBg, t.activeBorder, t.activeText)
                      : cn(t.controlBg, t.inactiveBorder, t.inactiveText, t.inactiveHoverText, t.inactiveHoverBorder),
                    'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:outline-none',
                    disabled && 'opacity-30 pointer-events-none',
                  )}
                  style={active ? { boxShadow: t.activeGlow } : undefined}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span>{p.ratio}</span>
                    <span className="text-[10px] opacity-60 font-normal">{p.dims}</span>
                  </span>
                </button>
              );
            })}
            <input
              type="text"
              value={current}
              onChange={(e) => onChange(e.target.value)}
              placeholder="custom"
              disabled={disabled}
              className={cn(
                'h-8 w-28 px-2 bg-black/60 rounded font-mono text-sm tabular-nums',
                theme ? cn(theme.controlBorder, 'border', theme.valueText) : 'border border-primary/30 text-primary/90',
                'placeholder:text-primary/30 focus:outline-none',
                theme?.focusBorder ?? 'focus:border-primary/60',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            />
          </div>
        </GenField>
      );
    }

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
      <GenField label={label} required={required} theme={theme} className="w-full">
        <GenTextarea
          value={(value as string) || ''}
          onChange={(v) => onChange(v)}
          placeholder={placeholder}
          disabled={disabled}
          rows={isPrompt ? 12 : 2}
          autoFocus={autoFocus}
          theme={theme}
        />
      </GenField>
    );
  }

  // Fallback for unknown types
  return (
    <GenField label={label} required={required} theme={theme}>
      <div className="text-xs text-red-400/70 font-mono">Unsupported field type: {schema.type}</div>
    </GenField>
  );
}
