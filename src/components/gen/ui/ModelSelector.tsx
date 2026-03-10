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
    <div className="max-w-xs">
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
