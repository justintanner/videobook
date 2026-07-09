import { Box, Globe } from 'lucide-react';
import { CommandDropdown } from '@/components/commands/CommandDropdown';
import type { ModelOption } from '../types';
import type { Domain } from '@/theme/domains';

interface ModelSelectorProps {
  selectedModelKey: string;
  modelOptions: ModelOption[];
  onChange: (modelKey: string) => void;
  disabled?: boolean;
  variant?: Domain;
}

export function ModelSelector({ selectedModelKey, modelOptions, onChange, disabled, variant }: ModelSelectorProps) {
  return (
    <CommandDropdown
      command="/model"
      value={selectedModelKey}
      options={modelOptions.map((o) => ({ value: o.key, label: o.label }))}
      onChange={onChange}
      disabled={disabled}
      icon={<Box className="w-3.5 h-3.5" />}
      variant={variant}
    />
  );
}

interface ProviderSelectorProps {
  selectedProvider: string;
  providers: string[];
  onChange: (provider: string) => void;
  disabled?: boolean;
  variant?: Domain;
}

export function ProviderSelector({ selectedProvider, providers, onChange, disabled, variant }: ProviderSelectorProps) {
  return (
    <CommandDropdown
      command="/provider"
      value={selectedProvider}
      options={providers.map((p) => ({ value: p, label: p }))}
      onChange={onChange}
      disabled={disabled}
      icon={<Globe className="w-3.5 h-3.5" />}
      variant={variant}
    />
  );
}

interface ModelProviderSelectorProps {
  selectedModelKey: string;
  selectedProviderKey: string;
  modelOptions: ModelOption[];
  onChange: (modelKey: string, providerKey: string) => void;
  disabled?: boolean;
  variant?: Domain;
}

/** Fused model·provider dropdown. Options are the cross-product of models ×
 *  their providers; the label shows the provider suffix only when a model has
 *  more than one provider (e.g. Gemini Omni · Google Flow vs Kling 3.0). The
 *  value is `modelKey::providerKey`; the panel re-resolves schema/tool/modes
 *  via fetchPreview on change. */
export function ModelProviderSelector({ selectedModelKey, selectedProviderKey, modelOptions, onChange, disabled, variant }: ModelProviderSelectorProps) {
  const options = modelOptions.flatMap((o) =>
    (o.providers ?? []).map((p) => ({
      value: `${o.key}::${p.key}`,
      label: (o.providers ?? []).length > 1 ? `${o.label} · ${p.label}` : o.label,
    })),
  );
  return (
    <CommandDropdown
      command="/model"
      value={`${selectedModelKey}::${selectedProviderKey}`}
      options={options}
      onChange={(raw) => {
        const idx = raw.indexOf('::');
        if (idx < 0) {
          onChange(raw, '');
          return;
        }
        onChange(raw.slice(0, idx), raw.slice(idx + 2));
      }}
      disabled={disabled}
      icon={<Box className="w-3.5 h-3.5" />}
      variant={variant}
    />
  );
}
