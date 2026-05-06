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
