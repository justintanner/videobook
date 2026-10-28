import type { Engine } from "videobook-engine";
import { activeBookEngine } from "../book-context.js";
import { appendDiagnostic } from "../diagnostics.js";
import { registerJobHandler } from "../queue.js";
import { localDate, readLedger, readSchedule, readSourceHealth, updateLedger, writeSourceHealth } from "../trending/ledger.js";
import { trendingSources, type TrendingSource } from "../trending/sources.js";

const pending = new WeakMap<Engine, Promise<unknown>>();

export async function sampleTrending(
  engine: Engine, slot: string, signal: AbortSignal,
  sources: ReadonlyMap<string, TrendingSource> = trendingSources,
): Promise<void> {
  const next = (pending.get(engine) ?? Promise.resolve()).then(async () => {
    const schedule = readSchedule(engine);
    if (!schedule?.enabled) return;
    const date = localDate(slot, schedule.timezone);
    if (readLedger(engine, date).completedSlots.includes(slot)) return;
    for (const configured of schedule.sources) {
      signal.throwIfAborted();
      const previous = readSourceHealth(engine)[configured.id] ?? {};
      try {
        const source = sources.get(configured.id);
        if (!source) throw new Error(`Trending source unavailable: ${configured.id}`);
        const snapshot = await source.sample({ country: schedule.country, window: schedule.window, limit: schedule.topN, options: configured.options }, { signal, previousHealth: previous });
        if (!snapshot) {
          await writeSourceHealth(engine, configured.id, { ...previous, ...source.health() });
          continue;
        }
        if (!Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error("Invalid source capture timestamp");
        const health = { ...source.health(), lastOk: new Date().toISOString(), lastCapturedAt: snapshot.capturedAt };
        if (previous.lastCapturedAt !== snapshot.capturedAt) {
          const sightings = snapshot.sightings.map((row) => ({ ...row, source: source.id, observedAt: snapshot.capturedAt }));
          const capturedDate = localDate(snapshot.capturedAt, schedule.timezone);
          await updateLedger(engine, capturedDate, (ledger) => ({
            ...ledger,
            sightings: [...ledger.sightings.filter((row) => row.source !== source.id || row.observedAt !== snapshot.capturedAt), ...sightings],
            sourceHealth: { ...ledger.sourceHealth, [source.id]: health },
            ...(snapshot.details ? { sourceDetails: { ...ledger.sourceDetails, [source.id]: snapshot.details } } : {}),
          }));
        }
        await writeSourceHealth(engine, configured.id, health);
      } catch (error) {
        signal.throwIfAborted();
        const health = { ...previous, lastError: error instanceof Error ? error.message : String(error) };
        await writeSourceHealth(engine, configured.id, health);
        await appendDiagnostic(engine, "trending-sample-failed", { scheduleId: schedule.scheduleId, error });
      }
    }
    await updateLedger(engine, date, (ledger) => ({ ...ledger, sourceHealth: readSourceHealth(engine), completedSlots: [...ledger.completedSlots, slot] }));
  });
  pending.set(engine, next.catch(() => {}));
  await next;
}

export function registerTrendingSampleJob(): void {
  registerJobHandler("trending_sample", async (payload, context) => {
    await sampleTrending(activeBookEngine(), String(payload.slot), context.signal);
    return { success: true };
  });
}
