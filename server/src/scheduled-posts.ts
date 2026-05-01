import { homedir } from "node:os";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { queue } from "./queue.js";

export interface ScheduledPostPayload {
  asset_id: string;
  project_slug: string;
  platform: "x";
  text?: string;
}

export type ScheduledPostStatus =
  | "pending"
  | "posted"
  | "failed"
  | "cancelled";

export interface ScheduledPostEntry {
  schedule_id: string;
  payload: ScheduledPostPayload;
  scheduled_for: string;
  created_at: string;
  status: ScheduledPostStatus;
  tweet_id?: string;
  tweet_url?: string;
  error?: string;
}

const REARM_INTERVAL_MS = 12 * 60 * 60_000;
const SAFE_TIMEOUT_MS = 2_147_483_000;

function defaultStateFile(): string {
  return (
    process.env.SCHEDULED_POSTS_PATH
    ?? join(homedir(), ".clipfirst", "scheduled-posts.json")
  );
}

const armed = new Map<string, NodeJS.Timeout>();
let writeChain: Promise<unknown> = Promise.resolve();
let rearmInterval: NodeJS.Timeout | null = null;

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function readState(): Promise<ScheduledPostEntry[]> {
  const path = defaultStateFile();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ScheduledPostEntry[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeState(entries: ScheduledPostEntry[]): Promise<void> {
  const path = defaultStateFile();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
  await rename(tmp, path);
}

async function updateEntry(
  scheduleId: string,
  patch: Partial<ScheduledPostEntry>,
): Promise<void> {
  await serialize(async () => {
    const entries = await readState();
    const updated = entries.map((entry) =>
      entry.schedule_id === scheduleId ? { ...entry, ...patch } : entry,
    );
    await writeState(updated);
  });
}

function armTimer(entry: ScheduledPostEntry): void {
  if (armed.has(entry.schedule_id)) return;
  if (entry.status !== "pending") return;
  const delay = new Date(entry.scheduled_for).getTime() - Date.now();
  const safeDelay = Math.min(Math.max(delay, 0), SAFE_TIMEOUT_MS);
  if (delay > SAFE_TIMEOUT_MS) {
    return;
  }
  const t = setTimeout(() => {
    armed.delete(entry.schedule_id);
    void firePost(entry.schedule_id);
  }, safeDelay);
  armed.set(entry.schedule_id, t);
}

async function firePost(scheduleId: string): Promise<void> {
  const entries = await readState();
  const entry = entries.find((e) => e.schedule_id === scheduleId);
  if (!entry || entry.status !== "pending") return;

  const jobId = `post-x-${scheduleId}`;
  try {
    const result = await queue.enqueueAndWait<{ tweet_id: string; tweet_url: string }>(
      jobId,
      {
        type: "post_to_x",
        assetId: entry.payload.asset_id,
        projectSlug: entry.payload.project_slug,
        text: entry.payload.text,
        scheduleId,
        scheduledFor: entry.scheduled_for,
      },
    );
    await updateEntry(scheduleId, {
      status: "posted",
      tweet_id: result.tweet_id,
      tweet_url: result.tweet_url,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateEntry(scheduleId, { status: "failed", error: message });
  }
}

export interface SchedulePostResult {
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
  const entry: ScheduledPostEntry = {
    schedule_id: randomUUID(),
    payload,
    scheduled_for: when.toISOString(),
    created_at: new Date().toISOString(),
    status: "pending",
  };
  await serialize(async () => {
    const entries = await readState();
    entries.push(entry);
    await writeState(entries);
  });
  armTimer(entry);
  return { schedule_id: entry.schedule_id, scheduled_for: entry.scheduled_for };
}

export async function cancelScheduledPost(scheduleId: string): Promise<boolean> {
  const timer = armed.get(scheduleId);
  if (timer) {
    clearTimeout(timer);
    armed.delete(scheduleId);
  }
  let found = false;
  await serialize(async () => {
    const entries = await readState();
    const updated = entries.map((entry) => {
      if (entry.schedule_id !== scheduleId) return entry;
      if (entry.status !== "pending") return entry;
      found = true;
      return { ...entry, status: "cancelled" as const };
    });
    await writeState(updated);
  });
  return found;
}

export async function listScheduledPosts(): Promise<ScheduledPostEntry[]> {
  return await readState();
}

export async function loadAndArmAll(): Promise<void> {
  const entries = await readState();
  const now = Date.now();
  for (const entry of entries) {
    if (entry.status !== "pending") continue;
    const due = new Date(entry.scheduled_for).getTime();
    if (due <= now) {
      void firePost(entry.schedule_id);
    } else {
      armTimer(entry);
    }
  }
  if (!rearmInterval) {
    rearmInterval = setInterval(() => {
      void rearmPending();
    }, REARM_INTERVAL_MS);
    rearmInterval.unref?.();
  }
}

async function rearmPending(): Promise<void> {
  const entries = await readState();
  for (const entry of entries) {
    if (entry.status !== "pending") continue;
    if (armed.has(entry.schedule_id)) continue;
    armTimer(entry);
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
