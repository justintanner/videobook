import type { Engine, NotebookCell } from "videobook-engine";
import { tryResolveModel } from "./media/descriptor.js";
import {
  parseStickySettings,
  stickySettingGroup,
  stickySettingsFor,
  stickySettingsFrom,
  takesDuration,
  type StickyControl,
  type StickySettings,
} from "./media/preferred-defaults.js";
import { controlsForModel } from "./notebook-generation-controls.js";

function settingsKey(notebookId: string): string {
  return `notebook-generation-settings:${notebookId}`;
}

function generationSettingsOf(cell: NotebookCell | undefined): Record<string, unknown> {
  const settings = cell?.inputs?.generationSettings;
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : {};
}

function changedSettings(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(next).filter(([name, value]) => previous[name] !== value));
}

export function readNotebookStickySettings(engine: Engine, notebookId: string): StickySettings {
  const stored = engine.settings.get<Record<string, unknown>>(settingsKey(notebookId));
  return stored ? parseStickySettings(stored) : {};
}

export function rememberNotebookStickySettings(
  engine: Engine,
  notebookId: string,
  next: NotebookCell,
  previous?: NotebookCell,
): void {
  const changed = stickySettingsFrom(changedSettings(generationSettingsOf(previous), generationSettingsOf(next)));
  if (Object.keys(changed).length === 0) return;
  const written = engine.settings.set(settingsKey(notebookId), {
    ...readNotebookStickySettings(engine, notebookId),
    ...changed,
  });
  if (!written.ok) throw new Error(written.error.message);
}

function stickyControlsFor(model: string): StickyControl[] {
  const resolved = tryResolveModel(model);
  if (!resolved) return [];
  const timed = takesDuration(resolved.entry);
  return controlsForModel(resolved).flatMap((control) => {
    const group = stickySettingGroup(control.name);
    if (!group || (group === "duration" && !timed)) return [];
    return [{
      name: control.name,
      valueType: control.valueType,
      options: control.options ?? [],
      ...(control.minimum === undefined ? {} : { minimum: control.minimum }),
      ...(control.maximum === undefined ? {} : { maximum: control.maximum }),
    }];
  });
}

export function seedNotebookStickySettings(cell: NotebookCell, sticky: StickySettings): NotebookCell {
  if (!cell.model || Object.keys(sticky).length === 0) return cell;
  const explicit = generationSettingsOf(cell);
  const seeded = stickySettingsFor(
    stickyControlsFor(cell.model).filter((control) => explicit[control.name] === undefined),
    sticky,
  );
  if (Object.keys(seeded).length === 0) return cell;
  return {
    ...cell,
    inputs: { ...(cell.inputs ?? {}), generationSettings: { ...seeded, ...explicit } },
  };
}
