import { SelectWithChevron } from '@/components/ui/SelectWithChevron';
import type { ModelOption } from '../types';

interface ModelSelectorProps {
  selectedModelKey: string;
  modelOptions: ModelOption[];
  onChange: (modelKey: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ selectedModelKey, modelOptions, onChange, disabled }: ModelSelectorProps) {
  return (
    <div className="space-y-1">
      <span className="text-sm font-bold tracking-[0.15em] text-primary/70">/model</span>
      <SelectWithChevron
        value={selectedModelKey}
        onChange={onChange}
        disabled={disabled}
        className="text-xs font-bold tracking-wide"
      >
        {modelOptions.map((option) => (
          <option key={option.key} value={option.key} className="bg-black text-primary">
            {option.label}
          </option>
        ))}
      </SelectWithChevron>
    </div>
  );
}

interface ProviderSelectorProps {
  selectedProvider: string;
  providers: string[];
  onChange: (provider: string) => void;
  disabled?: boolean;
}

export function ProviderSelector({ selectedProvider, providers, onChange, disabled }: ProviderSelectorProps) {
  return (
    <div className="space-y-1">
      <span className="text-sm font-bold tracking-[0.15em] text-primary/70">/provider</span>
      <SelectWithChevron
        value={selectedProvider}
        onChange={onChange}
        disabled={disabled}
        className="text-xs font-bold tracking-wide"
      >
        {providers.map((p) => (
          <option key={p} value={p} className="bg-black text-primary">
            {p}
          </option>
        ))}
      </SelectWithChevron>
    </div>
  );
}
