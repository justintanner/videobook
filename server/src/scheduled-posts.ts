import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import { logger } from "./logger.js";
import type {
  PostToXResult,
  XPostFollowup,
  XPostFollowupError,
  XPostReplyResult,
} from "./x/post-contract.js";
import {
  listBookEngines,
  queue,
  resolveBookEngine,
} from "./queue.js";

interface ScheduledPostPayload {
  asset_id: string;
  book_id: string;
  platform: "x";
  text?: string;
  orientation?: "portrait" | "landscape";
  followups?: XPostFollowup[];
}

type ScheduledPostStatus =
  | "pending"
  | "posted"
  | "partially_posted"
  | "failed"
  | "cancelled";

interface ScheduledPostEntry {
  schedule_id: string;
  payload: ScheduledPostPayload;
  scheduled_for: string;
  created_at: string;
  status: ScheduledPostStatus;
  tweet_id?: string;
  tweet_url?: string;
  replies?: XPostReplyResult[];
  followup_error?: XPostFollowupError | null;
  error?: string;
}

const REARM_INTERVAL_MS = 12 * 60 * 60_000;
const SAFE_TIMEOUT_MS = 2_147_483_000;
export const SCHEDULED_POST_SETTINGS_KEY = "application.scheduled_posts.v1";

const armed = new Map<string, NodeJS.Timeout>();
let writeChain: Promise<unknown> = Promise.resolve();
let rearmInterval: NodeJS.Timeout | null = null;

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

function readState(engine: Engine): ScheduledPostEntry[] {
  const entries = engine.settings.get<unknown>(SCHEDULED_POST_SETTINGS_KEY);
  return Array.isArray(entries) ? entries as ScheduledPostEntry[] : [];
}

function writeState(engine: Engine, entries: ScheduledPostEntry[]): void {
  const result = engine.settings.set(SCHEDULED_POST_SETTINGS_KEY, entries);
  if (!result.ok) throw new Error(result.error.message);
}

async function updateEntry(
  bookId: string,
  scheduleId: string,
  patch: Partial<ScheduledPostEntry>,
): Promise<void> {
  await serialize(async () => {
    const engine = await resolveBookEngine(bookId);
    const entries = readState(engine);
    const updated = entries.map((entry) =>
      entry.schedule_id === scheduleId ? { ...entry, ...patch } : entry,
    );
    writeState(engine, updated);
  });
}

function timerKey(bookId: string, scheduleId: string): string {
  return `${bookId}:${scheduleId}`;
}

function armTimer(bookId: string, entry: ScheduledPostEntry): void {
  const key = timerKey(bookId, entry.schedule_id);
  if (armed.has(key)) return;
  if (entry.status !== "pending") return;
  const delay = new Date(entry.scheduled_for).getTime() - Date.now();
  const safeDelay = Math.min(Math.max(delay, 0), SAFE_TIMEOUT_MS);
  if (delay > SAFE_TIMEOUT_MS) {
    return;
  }
  const t = setTimeout(() => {
    armed.delete(key);
    void firePost(bookId, entry.schedule_id).catch((e) =>
      logger.error(`[scheduled-posts] firePost ${entry.schedule_id} failed:`, e),
    );
  }, safeDelay);
  armed.set(key, t);
}

async function firePost(bookId: string, scheduleId: string): Promise<void> {
  const engine = await resolveBookEngine(bookId);
  const entries = readState(engine);
  const entry = entries.find((e) => e.schedule_id === scheduleId);
  if (!entry || entry.status !== "pending") return;

  const jobId = `post-x-${scheduleId}`;
  try {
    const result = await queue.enqueueAndWait<PostToXResult>(
      jobId,
      {
        type: "post_to_x",
        assetId: entry.payload.asset_id,
        bookId: entry.payload.book_id,
        text: entry.payload.text,
        orientation: entry.payload.orientation,
        scheduleId,
        scheduledFor: entry.scheduled_for,
        followups: entry.payload.followups,
      },
    );
    await updateEntry(bookId, scheduleId, {
      status: result.status,
      tweet_id: result.tweet_id,
      tweet_url: result.tweet_url,
      replies: result.replies,
      followup_error: result.followup_error,
      ...(result.followup_error ? { error: result.followup_error.message } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateEntry(bookId, scheduleId, { status: "failed", error: message });
  }
}

interface SchedulePostResult {
  schedule_id: string;
  scheduled_for: string;
}

export async function schedulePost(
  payload: ScheduledPostPayload,
  scheduledFor: string,
): Promise<SchedulePostResult> {
  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) {
    throw new Error(`Invalid scheduled_for: ${scheduledFor}`);
  }
  const engine = await resolveBookEngine(payload.book_id);
  const entry: ScheduledPostEntry = {
    schedule_id: randomUUID(),
    payload,
    scheduled_for: when.toISOString(),
    created_at: new Date().toISOString(),
    status: "pending",
  };
  await serialize(async () => {
    const entries = readState(engine);
    entries.push(entry);
    writeState(engine, entries);
  });
  armTimer(payload.book_id, entry);
  return { schedule_id: entry.schedule_id, scheduled_for: entry.scheduled_for };
}

export async function cancelScheduledPost(scheduleId: string): Promise<boolean> {
  let found = false;
  const engines = await listBookEngines();
  await serialize(async () => {
    for (const engine of engines) {
      const bookId = engine.book.get().bookId;
      const entries = readState(engine);
      let changed = false;
      const updated = entries.map((entry) => {
        if (entry.schedule_id !== scheduleId || entry.status !== "pending") {
          return entry;
        }
        found = true;
        changed = true;
        return { ...entry, status: "cancelled" as const };
      });
      if (!changed) continue;
      const key = timerKey(bookId, scheduleId);
      const timer = armed.get(key);
      if (timer) clearTimeout(timer);
      armed.delete(key);
      writeState(engine, updated);
    }
  });
  return found;
}

export async function listScheduledPosts(): Promise<ScheduledPostEntry[]> {
  const engines = await listBookEngines();
  return engines
    .flatMap((engine) => readState(engine))
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function loadAndArmAll(): Promise<void> {
  const now = Date.now();
  const engines = await listBookEngines();
  for (const engine of engines) {
    const bookId = engine.book.get().bookId;
    for (const entry of readState(engine)) {
      if (entry.status !== "pending") continue;
      const due = new Date(entry.scheduled_for).getTime();
      if (due <= now) {
        void firePost(bookId, entry.schedule_id).catch((e) =>
          logger.error(`[scheduled-posts] firePost ${entry.schedule_id} failed:`, e),
        );
      } else {
        armTimer(bookId, entry);
      }
    }
  }
  if (!rearmInterval) {
    rearmInterval = setInterval(() => {
      void rearmPending().catch((e) =>
        logger.error(`[scheduled-posts] rearmPending failed:`, e),
      );
    }, REARM_INTERVAL_MS);
    rearmInterval.unref?.();
  }
}

async function rearmPending(): Promise<void> {
  const engines = await listBookEngines();
  for (const engine of engines) {
    const bookId = engine.book.get().bookId;
    for (const entry of readState(engine)) {
      if (entry.status !== "pending") continue;
      if (armed.has(timerKey(bookId, entry.schedule_id))) continue;
      armTimer(bookId, entry);
    }
  }
}

export function stopScheduler(): void {
  for (const t of armed.values()) clearTimeout(t);
  armed.clear();
  if (rearmInterval) {
    clearInterval(rearmInterval);
    rearmInterval = null;
  }
}
