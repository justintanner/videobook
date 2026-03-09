import { useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GenTextarea } from '@/components/ui/GenField';
import { GenToggle } from '@/components/ui/GenToggle';

interface SceneEntry {
  prompt: string;
  duration: number;
}

interface MultiPromptEditorProps {
  value: SceneEntry[];
  onChange: (scenes: SceneEntry[]) => void;
  disabled?: boolean;
  /** When false, always keeps at least 1 scene (acts as main prompt) */
  hasMainPrompt?: boolean;
  /** Actions rendered in the header row next to the SCENES label */
  headerActions?: React.ReactNode;
}

const DURATION_OPTIONS = ['3', '5', '8', '10'] as const;

export function MultiPromptEditor({
  value,
  onChange,
  disabled,
  hasMainPrompt = true,
  headerActions,
}: MultiPromptEditorProps) {
  // When there's no main prompt field, ensure at least 1 scene exists
  useEffect(() => {
    if (!hasMainPrompt && value.length === 0) {
      onChange([{ prompt: '', duration: 5 }]);
    }
  }, [hasMainPrompt, value.length, onChange]);

  const addScene = () => {
    onChange([...value, { prompt: '', duration: 5 }]);
  };

  const removeScene = (index: number) => {
    const minScenes = hasMainPrompt ? 0 : 1;
    if (value.length <= minScenes) return;
    onChange(value.filter((_, i) => i !== index));
  };

  const updatePrompt = (index: number, prompt: string) => {
    const updated = value.map((scene, i) => (i === index ? { ...scene, prompt } : scene));
    onChange(updated);
  };

  const updateDuration = (index: number, duration: string) => {
    const updated = value.map((scene, i) => (i === index ? { ...scene, duration: parseInt(duration, 10) } : scene));
    onChange(updated);
  };

  const canRemove = hasMainPrompt ? true : value.length > 1;

  return (
    <div className="space-y-2">
      {value.length > 0 && headerActions && (
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-bold tracking-[0.15em] text-primary/50 uppercase">Scenes</span>
          <div className="flex items-center gap-2">{headerActions}</div>
        </div>
      )}
      {value.map((scene, index) => (
        <div key={index} className="space-y-1.5">
          {/* Scene header */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-[0.15em] text-primary/50 uppercase">Scene {index + 1}</span>
            <div className="flex items-center gap-2">
              <GenToggle
                value={String(scene.duration)}
                onChange={(val) => updateDuration(index, val)}
                options={DURATION_OPTIONS}
                disabled={disabled}
                compact
              />
              {canRemove && (
                <button
                  type="button"
                  onClick={() => removeScene(index)}
                  disabled={disabled}
                  className={cn(
                    'w-5 h-5 flex items-center justify-center rounded',
                    'text-red-400/60 hover:text-red-400 hover:bg-red-400/10',
                    'transition-colors duration-150',
                    'focus-visible:ring-1 focus-visible:ring-red-400/60 focus-visible:outline-none',
                    disabled && 'opacity-50 cursor-not-allowed'
                  )}
                  aria-label={`Remove scene ${index + 1}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Scene prompt */}
          <GenTextarea
            value={scene.prompt}
            onChange={(val) => updatePrompt(index, val)}
            placeholder={`Scene ${index + 1} prompt...`}
            disabled={disabled}
            rows={2}
          />
        </div>
      ))}

      {/* Add scene button */}
      <button
        type="button"
        onClick={addScene}
        disabled={disabled}
        className={cn(
          'w-full h-7 flex items-center justify-center gap-1.5 rounded',
          'border border-dashed border-primary/40',
          'text-[10px] font-bold tracking-[0.15em] text-primary/50 uppercase',
          'hover:border-primary/60 hover:text-primary/70 hover:bg-primary/5',
          'transition-all duration-200',
          'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:outline-none',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <Plus className="w-3 h-3" />
        <span>Scene</span>
      </button>
    </div>
  );
}
