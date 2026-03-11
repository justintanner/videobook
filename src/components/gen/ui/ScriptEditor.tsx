import { ScriptBlock } from '@/components/chat/ScriptBlocks';

interface ScriptEditorProps {
  dialog: string;
  onDialogChange: (value: string) => void;
  label?: string;
  audioActions?: React.ReactNode;
  onSave?: () => void;
  onCancel?: () => void;
  hasChanges?: boolean;
  isSaving?: boolean;
  autoFocus?: boolean;
}

export function ScriptEditor({
  dialog,
  onDialogChange,
  label = 'Prompt',
  audioActions,
  onSave,
  onCancel,
  hasChanges = false,
  isSaving = false,
  autoFocus,
}: ScriptEditorProps) {
  const normalizedDialog = dialog.replace(/\\n/g, '\n');

  return (
    <div className="space-y-2">
      <ScriptBlock
        label={label}
        content={normalizedDialog}
        onChange={onDialogChange}
        onSave={onSave}
        onCancel={onCancel}
        hasChanges={hasChanges}
        isSaving={isSaving}
        placeholder="Enter your prompt..."
        audioActions={audioActions}
        textSize="sm"
        autoFocus={autoFocus}
      />
    </div>
  );
}
