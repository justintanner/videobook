import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useOptionalCommandRegistry } from '@/contexts/CommandRegistryContext';
import { AutocompleteDropdown, type AutocompleteItem, type ColorScheme } from '@/components/ui/AutocompleteDropdown';
import type { ServerCommand } from '@/lib/command-registry';

const COMMAND_COLORS: Record<string, ColorScheme> = {
  action: 'cyan',
  project: 'amber',
  context_menu: 'violet',
  viewer: 'cyan',
};

interface UseSlashCommandPickerArgs {
  value: string;
  setValue: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onAfterDispatch?: () => void; // e.g. close popover on successful dispatch
}

interface UseSlashCommandPickerResult {
  isOpen: boolean;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  dropdown: ReactNode;
}

function buildItems(commands: ServerCommand[], filter: string): AutocompleteItem[] {
  const lower = filter.toLowerCase();
  return commands
    .filter((c) => c.command.slice(1).toLowerCase().includes(lower))
    .map((c) => ({
      type: 'command' as const,
      value: c.command,
      label: c.command,
      description: c.description,
      example: c.example,
      category: c.category,
      icon: c.icon,
      colorScheme: COMMAND_COLORS[c.category] ?? 'cyan',
    }));
}

export function useSlashCommandPicker({
  value,
  setValue,
  textareaRef,
  onAfterDispatch,
}: UseSlashCommandPickerArgs): UseSlashCommandPickerResult {
  const registry = useOptionalCommandRegistry();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const prevTriggerKeyRef = useRef<string | null>(null);

  const trigger = useMemo(() => {
    if (!registry) return null;
    // Match against full value; trigger fires when "/foo" sits at the very end
    // of the input — sufficient for the popover textareas this hook serves.
    const m = value.match(/(^|\s)\/([\w-]*)$/);
    if (!m) return null;
    const startPos = (m.index ?? 0) + m[1].length;
    return { filter: m[2], startPos };
  }, [registry, value]);

  const items = useMemo(
    () => (trigger && registry ? buildItems(registry.commands, trigger.filter) : []),
    [trigger, registry],
  );

  const triggerKey = trigger ? `slash:${trigger.filter}` : null;
  if (triggerKey !== prevTriggerKeyRef.current) {
    prevTriggerKeyRef.current = triggerKey;
    if (selectedIndex !== 0) setSelectedIndex(0);
    if (dismissed) setDismissed(false);
  }

  const isOpen = trigger !== null && items.length > 0 && !dismissed;

  const insertSelection = useCallback(
    (item: AutocompleteItem) => {
      if (!trigger) return;
      const before = value.slice(0, trigger.startPos);
      const caret = textareaRef.current?.selectionStart ?? value.length;
      const after = value.slice(caret);
      const next = `${before}${item.value} ${after}`;
      setValue(next);
      setDismissed(true);
      const cursorPos = before.length + item.value.length + 1;
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(cursorPos, cursorPos);
      });
    },
    [trigger, value, setValue, textareaRef],
  );

  const dispatchCurrent = useCallback(async () => {
    if (!registry) return;
    const trimmed = value.trim();
    if (!trimmed.startsWith('/')) return;
    const ok = await registry.dispatch(trimmed);
    if (ok) {
      setValue('');
      onAfterDispatch?.();
    }
  }, [registry, value, setValue, onAfterDispatch]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!isOpen) return false;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return true;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        insertSelection(items[selectedIndex]);
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const selected = items[selectedIndex];
        const trimmed = value.trim();
        if (selected && trimmed === selected.value) {
          // Exact bare command — dispatch directly.
          void dispatchCurrent();
        } else {
          insertSelection(selected);
        }
        return true;
      }
      return false;
    },
    [isOpen, items, selectedIndex, insertSelection, value, dispatchCurrent],
  );

  const dropdown = isOpen ? (
    <AutocompleteDropdown
      items={items}
      selectedIndex={selectedIndex}
      onSelect={insertSelection}
      onHover={setSelectedIndex}
    />
  ) : null;

  return { isOpen, onKeyDown, dropdown };
}
