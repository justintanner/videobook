import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { BookManager, ManagedBook } from "../book-manager.js";
import { queue } from "../queue.js";
import { ensureControlBook } from "../trending/control-book.js";
import {
  controlBookSlug, localDate, readHistory, readLedger, readRetention, readRuns, readSchedule, readSourceHealth, writeSchedule,
} from "../trending/ledger.js";
import { nextTrendingEvents, trendingCutTime } from "../trending/scheduler.js";
import type { TrendingSchedule } from "../trending/types.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const countries = new Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" "));
const schema = {
  op: z.enum(["schedule", "unschedule", "list", "run", "status"]),
  platform: z.literal("tiktok").optional(),
  country: z.string().refine((value) => countries.has(value.toUpperCase()), "Country must be an ISO alpha-2 code").optional(),
  timezone: z.string().refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Invalid timezone").optional(),
  cutoff_local_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  samples_per_day: z.number().int().min(1).max(24).optional(),
  top_n: z.number().int().min(1).max(63).optional(),
  window: z.enum(["trending", "posted"]).optional(),
  window_hours: z.number().int().min(1).max(168).optional(),
  exclude_promoted: z.boolean().optional(),
  ranking: z.enum(["views", "consensus"]).optional(),
  sources: z.array(z.object({ id: z.string().min(1), options: z.record(z.string(), z.unknown()).optional() })).min(1).optional(),
  downstream: z.object({ transcribe: z.boolean().optional(), translateTo: z.array(z.string().min(1)).optional(), analyze: z.boolean().optional() }).optional(),
  substitute_failures: z.boolean().optional(),
  retention_days: z.number().int().min(1).optional(),
  archive_top_clips: z.boolean().optional().describe("Archive completed ranked clips through archive_clip before retention deletes a day book"),
  enabled: z.boolean().optional(),
  date: z.iso.date().optional().describe("Local date to cut using the current ledger; omit to sample now"),
};

type Args = z.infer<z.ZodObject<typeof schema>>;

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function makeSchedule(args: Args, previous: TrendingSchedule | undefined, now: Date): TrendingSchedule {
  const country = args.country!;
  const timezone = args.timezone ?? previous?.timezone ?? (country === "TH" ? "Asia/Bangkok" : undefined);
  if (!timezone) throw new Error("timezone is required when creating a schedule outside TH");
  return {
    scheduleId: previous?.scheduleId ?? uuidv7(), platform: "tiktok", country, timezone,
    cutoffLocalTime: args.cutoff_local_time ?? previous?.cutoffLocalTime ?? "00:30",
    samplesPerDay: args.samples_per_day ?? previous?.samplesPerDay ?? 4,
    topN: args.top_n ?? previous?.topN ?? 10,
    window: args.window ?? previous?.window ?? "trending",
    windowHours: args.window_hours ?? previous?.windowHours ?? 24,
    excludePromoted: args.exclude_promoted ?? previous?.excludePromoted ?? true,
    ranking: args.ranking ?? previous?.ranking ?? "views",
    sources: args.sources ?? previous?.sources ?? [{ id: "endless" }, { id: "tiktok-creative-center" }],
    downstream: { transcribe: true, translateTo: [], analyze: false, ...previous?.downstream, ...args.downstream },
    substituteFailures: args.substitute_failures ?? previous?.substituteFailures ?? false,
    retentionDays: args.retention_days ?? previous?.retentionDays ?? 30,
    archiveTopClips: args.archive_top_clips ?? previous?.archiveTopClips ?? false,
    enabled: args.enabled ?? previous?.enabled ?? true,
    createdAt: previous?.createdAt ?? now.toISOString(),
  };
}

function status(book: ManagedBook, schedule: TrendingSchedule, date: string | undefined, now: Date) {
  const ledgerDate = date ?? localDate(now, schedule.timezone);
  const ledger = readLedger(book.engine, ledgerDate);
  const runs = readRuns(book.engine);
  const sourceHealth = readSourceHealth(book.engine);
  const counts: Record<string, number> = Object.fromEntries(schedule.sources.map(({ id }) => [id, 0]));
  for (const sighting of ledger.sightings) counts[sighting.source] = (counts[sighting.source] ?? 0) + 1;
  const nextRuns = schedule.enabled ? nextTrendingEvents(schedule, now) : { sample: null, cut: null };
  return {
    bookId: book.bookId, schedule, ledgerDate, ledgerCounts: counts, sourceHealth,
    lastSample: [...ledger.completedSlots, ...Object.values(sourceHealth).flatMap((health) => health.lastOk ? [health.lastOk] : [])].sort().at(-1) ?? null,
    lastRun: [...runs].sort((a, b) => b.cutAt.localeCompare(a.cutAt))[0] ?? null,
    nextRuns,
    retention: {
      days: schedule.retentionDays, archiveTopClips: schedule.archiveTopClips ?? false, nextRun: nextRuns.cut,
      lastRun: readRetention(book.engine) ?? null,
      recentDeletions: readHistory(book.engine).filter((entry) => entry.deletedAt).slice(-10)
        .map(({ date, dayBookId, dayBookName, deletedAt, spend }) => ({ date, dayBookId, dayBookName, deletedAt, spend })),
    },
    recentFailures: {
      sources: Object.entries(sourceHealth).filter(([, health]) => health.lastError).map(([source, health]) => ({ source, error: health.lastError })),
      runs: runs.filter((run) => run.errors.length || run.downloads.some((download) => download.error)).slice(-10),
      jobs: book.engine.jobs.queue.list({ states: ["failed", "aborted"] }).filter((job) => job.type.startsWith("trending_")).slice(-10),
    },
  };
}

export function trendingResearchDef(books: BookManager, options: {
  enqueue?: typeof queue.enqueue;
  now?: () => Date;
} = {}): ToolDef {
  return {
    name: "trending_research",
    description: "Schedule, unschedule, list, run or inspect country TikTok research. The run operation samples now, or cuts a day book for date using the existing ledger. Unschedule disables future automatic runs and preserves research history. After each cutoff, day books older than retention_days are deleted once their rank list, sources and download outcomes are copied into the control book; archive_top_clips archives their completed clips first, and the archiving's provider usage is copied into the control book too. Sighting ledgers older than both retention_days and the cut's 8-day read window are pruned. TH defaults to Asia/Bangkok; other countries require timezone on creation.",
    scope: "global",
    schema,
    handler: async (input) => {
      try {
        const parsed = z.object(schema).parse(input);
        const args = { ...parsed, country: parsed.country?.toUpperCase() };
        const now = (options.now ?? (() => new Date()))();
        await books.ready();
        if (args.op === "list" || args.op === "status") {
          const schedules = books.list().flatMap(({ bookId }) => {
            const selected = books.get(bookId);
            if (!selected.ok) return [];
            const schedule = readSchedule(selected.value.engine);
            if (!schedule || (args.country && schedule.country !== args.country)) return [];
            return [args.op === "status" ? status(selected.value, schedule, args.date, now) : { bookId, schedule }];
          });
          return json({ schedules });
        }
        if (!args.country) throw new Error(`country is required for ${args.op}`);
        const selected = books.getByName(controlBookSlug(args.country));
        const previous = selected.ok ? readSchedule(selected.value.engine) : undefined;
        if (args.op === "schedule") {
          const schedule = makeSchedule(args, previous, now);
          const book = await ensureControlBook(books, schedule);
          return json({ bookId: book.bookId, schedule });
        }
        if (!selected.ok || !previous) throw new Error(`No research schedule for ${args.country}; create one with op=schedule`);
        if (args.op === "unschedule") {
          const schedule = { ...previous, enabled: false };
          await writeSchedule(selected.value.engine, schedule);
          return json({ bookId: selected.value.bookId, schedule });
        }
        if (!previous.enabled) throw new Error("Research schedule is disabled; enable it with op=schedule enabled=true before running");
        const bookId = selected.value.bookId;
        const slot = now.toISOString();
        const key = args.date ? `trending-cut:${previous.scheduleId}:${args.date}` : `trending-sample:${previous.scheduleId}:${slot}`;
        const payload = args.date
          ? { type: "trending_cut", bookId, date: args.date, cutAt: trendingCutTime(previous, args.date) }
          : { type: "trending_sample", bookId, slot };
        const job = await (options.enqueue ?? queue.enqueue)(key, payload);
        return json({ jobs: [{ bookId, jobId: job.id, jobKey: key }] });
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  };
}
