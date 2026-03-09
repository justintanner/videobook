import { SelectWithChevron } from '@/components/ui/SelectWithChevron';

interface GenSelectOption {
  value: string;
  label: string;
}

interface GenSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: GenSelectOption[];
  disabled?: boolean;
}

export function GenSelect({ value, onChange, options, disabled }: GenSelectProps) {
  return (
    <SelectWithChevron value={value} onChange={onChange} disabled={disabled} className="text-xs">
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-black text-primary">
          {option.label}
        </option>
      ))}
    </SelectWithChevron>
  );
}
