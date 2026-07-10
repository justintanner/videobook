import { Box, Globe, Layers } from 'lucide-react';
import { CommandDropdown } from '@/components/commands/CommandDropdown';
import type { ModelModes, ModelOption } from '../types';
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

interface ModeSelectorProps {
  modes: ModelModes;
  selectedModeKey: string;
  onChange: (modeKey: string) => void;
  disabled?: boolean;
  variant?: Domain;
}

/** Generation-type picker for models that ship a modes contract (e.g. Omni
 *  text / first-frame / refs / video-edit). Rendered next to the model
 *  dropdown as `/type`. */
export function ModeSelector({ modes, selectedModeKey, onChange, disabled, variant }: ModeSelectorProps) {
  return (
    <CommandDropdown
      command="/type"
      value={selectedModeKey}
      options={modes.modes.map((m) => ({ value: m.key, label: m.label }))}
      onChange={onChange}
      disabled={disabled}
      icon={<Layers className="w-3.5 h-3.5" />}
      variant={variant}
    />
  );
}
