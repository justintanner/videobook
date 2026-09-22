import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import { withNotebookMutation } from "../notebook-mutations.js";
import { rhythmSettingsSchema, type RhythmSettings, type RhythmState } from "./model.js";
import { soundtrackClip } from "./timing.js";
import { musicSource } from "./music-analysis.js";

const documentSchema = z.object({
  revision: z.string(), settings: rhythmSettingsSchema,
  past: z.array(rhythmSettingsSchema).max(20), future: z.array(rhythmSettingsSchema).max(20),
});

async function rhythmDocument(engine: Engine, sequenceId: string) {
  if (!engine.sequences.get(sequenceId).ok) throw new Error("The sequence no longer exists");
  const saved = await engine.metadata.book.read(`music.rhythm.${sequenceId}`);
  if (saved.ok) return documentSchema.parse(saved.value);
  return { revision: "none", settings: { masterClipId: null, correction: null }, past: [], future: [] } as z.infer<typeof documentSchema>;
}

function state(document: z.infer<typeof documentSchema>): RhythmState {
  return { revision: document.revision, settings: document.settings, canUndo: document.past.length > 0, canRedo: document.future.length > 0 };
}

export async function readSequenceRhythm(engine: Engine, sequenceId: string): Promise<RhythmState> {
  return state(await rhythmDocument(engine, sequenceId));
}

export async function updateSequenceRhythm(engine: Engine, sequenceId: string, expectedRevision: string, update: RhythmSettings | "undo" | "redo") {
  return withNotebookMutation(`rhythm:${engine.book.get().bookId}:${sequenceId}`, async () => {
    const current = await rhythmDocument(engine, sequenceId);
    if (current.revision !== expectedRevision) throw new Error("The beat map changed. Reload it before editing.");
    const sequence = engine.sequences.get(sequenceId);
    if (!sequence.ok) throw new Error(sequence.error.message);
    const settings = update === "undo" ? current.past.at(-1) : update === "redo" ? current.future.at(-1) : rhythmSettingsSchema.parse(update);
    if (!settings) throw new Error(`Nothing to ${update}`);
    const master = soundtrackClip(sequence.value, settings);
    if (settings.masterClipId && !master) throw new Error("The selected soundtrack clip is no longer available");
    if (settings.correction) {
      if (!master || settings.correction.objectHash !== master.source.range.objectHash) throw new Error("The soundtrack changed. Reset its beat map before editing.");
      const source = await musicSource(engine, master.source.artifactId, master.source.range.streamId);
      if (source.objectHash !== settings.correction.objectHash) throw new Error("The audio source changed");
      if (sequence.value.tracks.find((track) => track.trackId === master.trackId)?.locked) throw new Error("Unlock the soundtrack track before correcting its beat map");
      const streams = engine.streams.get(master.source.range.streamId);
      if (!streams.ok || streams.value.objectHash !== settings.correction.objectHash) throw new Error("The audio source changed");
      const duration = streams.value.durationTicks * streams.value.timeBase.numerator / streams.value.timeBase.denominator;
      if (settings.correction.markers.some((marker) => marker.timeSeconds >= duration)) throw new Error("Beat markers must be inside the source audio");
      const ids = new Set(settings.correction.markers.map((marker) => marker.id));
      if (ids.size !== settings.correction.markers.length) throw new Error("Beat marker IDs must be unique");
      settings.correction.markers.sort((left, right) => left.timeSeconds - right.timeSeconds);
    }
    const next = { revision: randomUUID(), settings,
      past: update === "undo" ? current.past.slice(0, -1) : [...current.past, current.settings].slice(-20),
      future: update === "redo" ? current.future.slice(0, -1) : update === "undo" ? [...current.future, current.settings].slice(-20) : [],
    };
    const saved = await engine.metadata.book.write(`music.rhythm.${sequenceId}`, next);
    if (!saved.ok) throw new Error(saved.error.message);
    return state(next);
  });
}
