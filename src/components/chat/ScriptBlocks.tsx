import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Save, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function EditableBlock({
  content,
  onChange,
  disabled,
  placeholder,
  textSize = 'xs',
  autoFocus,
}: {
  content: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  textSize?: 'xs' | 'sm';
  autoFocus?: boolean;
}) {
  const [isEditing, setIsEditing] = useState(autoFocus ?? false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.selectionStart = len;
      textareaRef.current.selectionEnd = len;
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [isEditing]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  const textClass = textSize === 'xs' ? 'text-xs' : 'text-sm';

  if (isEditing) {
    return (
      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onBlur={() => setIsEditing(false)}
        disabled={disabled}
        rows={1}
        placeholder={placeholder}
        className={cn(
          'w-full px-3 py-2 resize-none rounded min-h-[200px]',
          'bg-black/60',
          'border border-solid border-primary/40',
          'text-primary/90 placeholder:text-primary/30',
          `font-mono ${textClass} leading-relaxed`,
          'focus:outline-none focus:border-primary/60',
          'shadow-[0_0_15px_-3px_rgba(0,255,255,0.3)]',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      />
    );
  }

  return (
    <div
      onClick={() => !disabled && setIsEditing(true)}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          setIsEditing(true);
        }
      }}
      tabIndex={disabled ? undefined : 0}
      role="textbox"
      aria-readonly="true"
      aria-disabled={disabled || undefined}
      className={cn(
        'w-full px-3 py-2 rounded cursor-text min-h-[120px]',
        'bg-black/60',
        'border border-solid border-primary/40',
        `text-primary/90 font-mono ${textClass} leading-relaxed whitespace-pre-wrap`,
        'transition-all duration-200',
        'hover:border-primary/60',
        'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:outline-none',
        'hover:shadow-[0_0_15px_-3px_rgba(0,255,255,0.3)]',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      {content || <span className="text-primary/30 italic">{placeholder ?? 'Click to edit...'}</span>}
    </div>
  );
}

export function ScriptBlock({
  label,
  content,
  onChange,
  onSave,
  onCancel,
  hasChanges = false,
  isSaving = false,
  placeholder,
  audioActions,
  textSize = 'xs',
  autoFocus,
}: {
  label: string;
  content: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
  hasChanges?: boolean;
  isSaving?: boolean;
  placeholder?: string;
  audioActions?: React.ReactNode;
  textSize?: 'xs' | 'sm';
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold tracking-[0.15em] uppercase text-primary/70">[{label}]</span>
        <div className="flex items-center gap-1">
          {audioActions}
          {hasChanges && onSave && onCancel && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancel}
                disabled={isSaving}
                className="h-5 px-1.5 text-[10px] text-primary/70 hover:text-primary hover:bg-primary/10"
              >
                <X className="w-3 h-3 mr-0.5" />
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={onSave}
                disabled={isSaving}
                className="h-5 px-1.5 text-[10px]"
              >
                {isSaving ? <Loader2 className="w-3 h-3 mr-0.5 animate-spin" /> : <Save className="w-3 h-3 mr-0.5" />}
                Save
              </Button>
            </>
          )}
        </div>
      </div>
      <EditableBlock
        content={content}
        onChange={onChange}
        disabled={isSaving}
        placeholder={placeholder}
        textSize={textSize}
        autoFocus={autoFocus}
      />
    </div>
  );
}
