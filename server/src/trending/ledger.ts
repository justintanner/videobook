import type { Engine } from "videobook-engine";
import { normalizeBookSlug } from "videobook-engine/book-slug";
import type { SourceHealth, TrendingLedger, TrendingRunRecord, TrendingSchedule } from "./types.js";

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

export function readSchedule(engine: Engine): TrendingSchedule | undefined {
  return engine.settings.get<TrendingSchedule>("trending.schedule.v1") ?? undefined;
}

export function writeSchedule(engine: Engine, schedule: TrendingSchedule): Promise<void> {
  return serialize(engine, () => write(engine, "trending.schedule.v1", schedule));
}

export function readLedger(engine: Engine, date: string): TrendingLedger {
  return engine.settings.get<TrendingLedger>(`trending.ledger.${validateLocalDate(date)}`)
    ?? { sightings: [], sourceHealth: {}, completedSlots: [] };
}

export function updateLedger(
  engine: Engine, date: string, update: (ledger: TrendingLedger) => TrendingLedger,
): Promise<void> {
  return serialize(engine, () => write(engine, `trending.ledger.${validateLocalDate(date)}`, update(readLedger(engine, date))));
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

export function readSourceHealth(engine: Engine): Record<string, SourceHealth> {
  return engine.settings.get<Record<string, SourceHealth>>("trending.source-health.v1") ?? {};
}

export function writeSourceHealth(engine: Engine, source: string, health: SourceHealth): Promise<void> {
  return serialize(engine, () => write(engine, "trending.source-health.v1", {
    ...readSourceHealth(engine), [source]: health,
  }));
}
