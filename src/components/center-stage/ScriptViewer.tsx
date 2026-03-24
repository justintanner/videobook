import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Settings, FileText, Save, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import { useMountKey } from '@/contexts/MountKeyContext';
import type { UseMcpResult } from 'use-mcp/react';
import type { BackTab } from './viewer-types';
import {
  ViewerToolbar,
  BackFaceTabBar,
  FilesBackPane,
  HistoryBackPane,
  useViewerBackFace,
} from './viewer-shared';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import { AutocompleteDropdown } from '@/components/ui/AutocompleteDropdown';
import type { AutocompleteItem, ColorScheme } from '@/components/ui/AutocompleteDropdown';

// ── ScriptViewer ──

const SCRIPT_BACK_TABS: BackTab[] = ['files', 'history'];

const COMMAND_COLORS: Record<string, ColorScheme> = {
  action: 'cyan',
  project: 'amber',
  context_menu: 'violet',
  viewer: 'cyan',
  editor: 'cyan',
};

const LOCAL_COMMANDS: AutocompleteItem[] = [
  { type: 'command', value: '/save', label: '/save', description: 'Save changes (⌘S)', icon: 'save', colorScheme: 'cyan' },
  { type: 'command', value: '/cancel', label: '/cancel', description: 'Discard changes', icon: 'x', colorScheme: 'cyan' },
];

/** Extract the current line text up to cursor position */
function getCurrentLineAtCursor(text: string, cursorPos: number): { line: string; lineStart: number } {
  const lineStart = text.lastIndexOf('\n', cursorPos - 1) + 1;
  return { line: text.slice(lineStart, cursorPos), lineStart };
}

export function ScriptViewer({ item, projectSlug, flipped, onFlippedChange, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, callTool }: {
  item: MediaItem;
  projectSlug: string;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
  pendingFilePosition?: number | null;
  onClearPendingFilePosition?: () => void;
  pendingBackTab?: BackTab | null;
  onClearPendingBackTab?: () => void;
  callTool: UseMcpResult['callTool'];
}) {
  useMountKey('viewer');

  const { dispatch, commands } = useCommandDispatch();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [draft, setDraft] = useState(item.prompt ?? '');
  const [saving, setSaving] = useState(false);
  const isDirty = draft !== (item.prompt ?? '');
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;

  // Slash command autocomplete state
  const [cursorPos, setCursorPos] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Detect slash trigger on the current line
  const slashTrigger = useMemo(() => {
    const { line } = getCurrentLineAtCursor(draft, cursorPos);
    const match = line.match(/^\/([\w-]*)$/);
    if (!match) return null;
    return { filter: match[1] };
  }, [draft, cursorPos]);

  // Build autocomplete items: local commands + registry commands
  const autocompleteItems = useMemo((): AutocompleteItem[] => {
    if (!slashTrigger) return [];
    const filter = slashTrigger.filter.toLowerCase();

    const localFiltered = LOCAL_COMMANDS.filter(
      (c) => c.value.slice(1).toLowerCase().includes(filter),
    );
    const registryFiltered = commands
      .filter((c) => c.command.slice(1).toLowerCase().includes(filter))
      .map((c) => ({
        type: 'command' as const,
        value: c.command,
        label: c.command,
        description: c.description,
        example: c.example,
        category: c.category,
        icon: c.icon,
        colorScheme: (COMMAND_COLORS[c.category] ?? 'cyan') as ColorScheme,
      }));

    return [...localFiltered, ...registryFiltered];
  }, [slashTrigger, commands]);

  const showSuggestions = slashTrigger !== null && autocompleteItems.length > 0 && !dismissed;

  // Reset selectedIndex and dismissed when trigger changes
  const prevFilter = useRef<string | null>(null);
  const currentFilter = slashTrigger?.filter ?? null;
  if (currentFilter !== prevFilter.current) {
    prevFilter.current = currentFilter;
    if (dismissed) setDismissed(false);
    if (selectedIndex !== 0) setSelectedIndex(0);
  }

  // Reset draft when switching items (with confirmation if dirty)
  const prevItemId = useRef(item.id);
  useEffect(() => {
    if (item.id !== prevItemId.current) {
      if (dirtyRef.current && !window.confirm('You have unsaved changes. Discard them?')) {
        return;
      }
      prevItemId.current = item.id;
      setDraft(item.prompt ?? '');
    }
  }, [item.id, item.prompt]);

  // Sync draft when item.prompt updates externally (e.g. after save + sync)
  // but only when not dirty
  useEffect(() => {
    if (!dirtyRef.current) {
      setDraft(item.prompt ?? '');
    }
  }, [item.prompt]);

  // beforeunload protection
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Save handler
  const handleSave = useCallback(async () => {
    if (saving || !isDirty) return;
    setSaving(true);
    try {
      const result = await callTool('update_script', {
        asset_id: item.id,
        content: draft,
        project_slug: projectSlug,
      });
      if (result.isError) {
        const msg = result.content?.[0]?.type === 'text' ? result.content[0].text : 'Save failed';
        alert(msg);
        return;
      }
      // Trigger sync so item.prompt refreshes
      await callTool('sync', { project_slug: projectSlug });
    } finally {
      setSaving(false);
    }
  }, [saving, isDirty, callTool, item.id, draft, projectSlug]);

  // Cmd+S / Ctrl+S keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirtyRef.current) handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // Strip the current /command line from the draft
  const stripCommandLine = useCallback(() => {
    const pos = textareaRef.current?.selectionStart ?? cursorPos;
    const { lineStart } = getCurrentLineAtCursor(draft, pos);
    // Find line end
    let lineEnd = draft.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = draft.length;
    // Remove the line (and trailing newline if present)
    const before = draft.slice(0, lineStart);
    const after = draft.slice(lineEnd + 1); // +1 to eat the \n
    const newDraft = before + after;
    setDraft(newDraft);
    // Restore cursor to line start
    setTimeout(() => {
      textareaRef.current?.setSelectionRange(lineStart, lineStart);
    }, 0);
  }, [draft, cursorPos]);

  // Execute a slash command (local or registry)
  const executeCommand = useCallback((commandValue: string) => {
    if (commandValue === '/save') {
      stripCommandLine();
      handleSave();
    } else if (commandValue === '/cancel') {
      setDraft(item.prompt ?? '');
    } else {
      stripCommandLine();
      dispatch(commandValue);
    }
  }, [stripCommandLine, handleSave, item.prompt, dispatch]);

  // Select an autocomplete suggestion
  const selectSuggestion = useCallback((acItem: AutocompleteItem) => {
    executeCommand(acItem.value);
    setDismissed(true);
  }, [executeCommand]);

  // Track cursor position
  const updateCursorPos = useCallback(() => {
    const pos = textareaRef.current?.selectionStart ?? 0;
    setCursorPos(pos);
  }, []);

  // Handle keyboard in the textarea
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showSuggestions) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % autocompleteItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + autocompleteItems.length) % autocompleteItems.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectSuggestion(autocompleteItems[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
    }
  }, [showSuggestions, autocompleteItems, selectedIndex, selectSuggestion]);

  const bf = useViewerBackFace({
    projectSlug,
    itemId: item.id,
    callTool,
    flipped,
    onFlippedChange,
    pendingFilePosition,
    onClearPendingFilePosition,
    pendingBackTab,
    onClearPendingBackTab,
    defaultBackTab: 'files',
  });

  // Guard flip-to-back when dirty
  const { handleFlipToBack: bfFlip } = bf;
  const handleFlipToBack = useCallback(() => {
    if (isDirty && !window.confirm('You have unsaved changes. Discard them?')) return;
    bfFlip();
  }, [isDirty, bfFlip]);

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div className="flip-card-perspective w-full h-full">
        <div className={cn(
          'flip-card-inner w-full h-full relative',
          flipped && 'flipped',
        )}>
          {/* FRONT FACE */}
          <div className={cn(
            'flip-card-face absolute inset-0 flex flex-col overflow-hidden',
            'border border-zinc-600/50',
          )}>
            <ViewerToolbar
              left={
                <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-primary/70">
                  <FileText className="w-3.5 h-3.5" />
                  <span>MARKDOWN</span>
                  {isDirty && <span className="text-yellow-400/80 text-[10px]">(unsaved)</span>}
                </span>
              }
              slug={item.slug}
              right={
                <button
                  tabIndex={-1}
                  onClick={handleFlipToBack}
                  title="/files"
                  className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
                >
                  <Settings className="w-4 h-4 stroke-[2.5]" />
                </button>
              }
            />

            <div className="flex-1 bg-black flex min-h-0 relative">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => { setDraft(e.target.value); updateCursorPos(); }}
                onKeyDown={handleKeyDown}
                onKeyUp={updateCursorPos}
                onClick={updateCursorPos}
                onSelect={updateCursorPos}
                disabled={saving}
                placeholder="Write your script here..."
                className={cn(
                  'w-full h-full resize-none p-6',
                  'bg-transparent',
                  'text-sm leading-relaxed text-primary/70 placeholder:text-primary/20',
                  'font-mono',
                  'focus:outline-none',
                  'overflow-y-auto',
                  saving && 'opacity-50 cursor-not-allowed',
                )}
              />

              {/* Slash command autocomplete */}
              {showSuggestions && (
                <div className="absolute bottom-12 right-3 w-72">
                  <AutocompleteDropdown
                    items={autocompleteItems}
                    selectedIndex={selectedIndex}
                    onSelect={selectSuggestion}
                    onHover={setSelectedIndex}
                  />
                </div>
              )}

              {/* /save and /cancel buttons */}
              {isDirty && (
                <div className="absolute bottom-3 right-3 flex items-center gap-2">
                  <button
                    onClick={() => setDraft(item.prompt ?? '')}
                    disabled={saving}
                    className="px-3 py-1.5 text-xs font-mono text-primary/60 hover:text-primary bg-zinc-800/80 hover:bg-zinc-700/80 border border-zinc-600/50 rounded transition-colors duration-150 disabled:opacity-50"
                  >
                    /cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    title="Save (⌘S)"
                    className="px-3 py-1.5 text-xs font-mono font-bold text-black bg-yellow-400 hover:bg-yellow-300 rounded transition-colors duration-150 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {saving
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Save className="w-3.5 h-3.5" />
                    }
                    /save
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            <BackFaceTabBar
              tabs={SCRIPT_BACK_TABS}
              active={bf.backTab}
              onSelect={bf.setBackTab}
              slug={item.slug}
              onClose={() => onFlippedChange(false)}
            />

            {bf.backTab === 'files' ? (
              <FilesBackPane
                manifest={bf.manifest}
                manifestLoading={bf.manifestLoading}
                selectedFile={bf.selectedFile}
                fileContent={bf.fileContent}
                fileLoading={bf.fileLoading}
                fileUrl={bf.fileUrl}
                handleSelectFile={bf.handleSelectFile}
                handleFileKeyDown={bf.handleFileKeyDown}
                fetchManifest={bf.fetchManifest}
                fetchFileContent={bf.fetchFileContent}
              />
            ) : (
              <HistoryBackPane
                commits={bf.commits}
                historyLoading={bf.historyLoading}
                selectedCommitHash={bf.selectedCommitHash}
                setSelectedCommitHash={bf.setSelectedCommitHash}
                handleRestore={bf.handleRestore}
                fetchHistory={bf.fetchHistory}
                itemId={item.id}
                projectSlug={projectSlug}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
