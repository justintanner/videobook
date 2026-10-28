import type { Engine } from "videobook-engine";
import { normalizeBookSlug } from "videobook-engine/book-slug";
import type {
  SourceHealth, TrendingHistoryEntry, TrendingLedger, TrendingRetentionState, TrendingRunRecord, TrendingSchedule,
} from "./types.js";

const chains = new WeakMap<Engine, Promise<unknown>>();

function serialize<T>(engine: Engine, update: () => T): Promise<T> {
  const next = (chains.get(engine) ?? Promise.resolve()).then(update);
  chains.set(engine, next.catch(() => {}));
  return next;
}

function write(engine: Engine, key: string, value: unknown): void {
  const result = engine.settings.set(key, value);
  if (!result.ok) throw new Error(result.error.message);
}

function validateLocalDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid local date: ${date}`);
  }
  return date;
}

function countrySlug(country: string): string {
  if (!/^[a-z]{2}$/i.test(country)) throw new Error("Country must be an ISO alpha-2 code");
  return country.toLowerCase();
}

export function controlBookSlug(country: string): string {
  return normalizeBookSlug(`tiktok-${countrySlug(country)}-research`);
}

export function dayBookSlug(country: string, date: string): string {
  return normalizeBookSlug(`tiktok-${countrySlug(country)}-${validateLocalDate(date)}`);
}

export function localDate(at: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: string): string => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function retentionStart(date: string, retentionDays: number): string | undefined {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) return undefined;
  return new Date(Date.parse(validateLocalDate(date)) - retentionDays * 86_400_000).toISOString().slice(0, 10);
}

export function readSchedule(engine: Engine): TrendingSchedule | undefined {
  return engine.settings.get<TrendingSchedule>("trending.schedule.v1") ?? undefined;
}

export function writeSchedule(engine: Engine, schedule: TrendingSchedule): Promise<void> {
  return serialize(engine, () => write(engine, "trending.schedule.v1", schedule));
}

export function cutLedgerDates(schedule: TrendingSchedule, cutAt: string): string[] {
  const dates = new Set<string>();
  const window = Math.max(48, schedule.windowHours);
  for (let hour = 0; hour <= Math.max(window + 24, 8 * 24); hour += 1) {
    dates.add(localDate(new Date(Date.parse(cutAt) - hour * 3_600_000), schedule.timezone));
  }
  return [...dates];
}

function ledgerKey(date: string): string {
  return `trending.ledger.${validateLocalDate(date)}`;
}

function readLedgerDates(engine: Engine): string[] {
  return engine.settings.get<string[]>("trending.ledgers.v1") ?? [];
}

export function readLedger(engine: Engine, date: string): TrendingLedger {
  return engine.settings.get<TrendingLedger>(ledgerKey(date))
    ?? { sightings: [], sourceHealth: {}, completedSlots: [] };
}

export function updateLedger(
  engine: Engine, date: string, update: (ledger: TrendingLedger) => TrendingLedger,
): Promise<void> {
  return serialize(engine, () => {
    const ledger = update(readLedger(engine, date));
    const dates = readLedgerDates(engine);
    if (!dates.includes(date)) write(engine, "trending.ledgers.v1", [...dates, date].sort());
    write(engine, ledgerKey(date), ledger);
  });
}

export function pruneLedgers(engine: Engine, before: string): Promise<string[]> {
  return serialize(engine, () => {
    validateLocalDate(before);
    const dates = readLedgerDates(engine);
    const expired = dates.filter((date) => date < before);
    for (const date of expired) {
      const deleted = engine.settings.delete(ledgerKey(date));
      if (!deleted.ok) throw new Error(deleted.error.message);
    }
    if (expired.length > 0) write(engine, "trending.ledgers.v1", dates.filter((date) => date >= before));
    return expired;
  });
}

export function readRuns(engine: Engine): TrendingRunRecord[] {
  return engine.settings.get<TrendingRunRecord[]>("trending.runs.v1") ?? [];
}

export function writeRun(engine: Engine, run: TrendingRunRecord): Promise<void> {
  validateLocalDate(run.date);
  return serialize(engine, () => write(engine, "trending.runs.v1", [
    ...readRuns(engine).filter((entry) => entry.date !== run.date), run,
  ]));
}

export function removeRun(engine: Engine, date: string): Promise<void> {
  return serialize(engine, () => write(engine, "trending.runs.v1", readRuns(engine).filter((entry) => entry.date !== date)));
}

export function readHistory(engine: Engine): TrendingHistoryEntry[] {
  return engine.settings.get<TrendingHistoryEntry[]>("trending.history.v1") ?? [];
}

export function writeHistory(engine: Engine, entry: TrendingHistoryEntry): Promise<void> {
  validateLocalDate(entry.date);
  return serialize(engine, () => write(engine, "trending.history.v1", [
    ...readHistory(engine).filter((previous) => previous.date !== entry.date), entry,
  ].sort((left, right) => left.date.localeCompare(right.date))));
}

export function readRetention(engine: Engine): TrendingRetentionState | undefined {
  return engine.settings.get<TrendingRetentionState>("trending.retention.v1") ?? undefined;
}

export function writeRetention(engine: Engine, state: TrendingRetentionState): Promise<void> {
  return serialize(engine, () => write(engine, "trending.retention.v1", state));
}

export function readSourceHealth(engine: Engine): Record<string, SourceHealth> {
  return engine.settings.get<Record<string, SourceHealth>>("trending.source-health.v1") ?? {};
}

export function writeSourceHealth(engine: Engine, source: string, health: SourceHealth): Promise<void> {
  return serialize(engine, () => write(engine, "trending.source-health.v1", {
    ...readSourceHealth(engine), [source]: health,
  }));
}
