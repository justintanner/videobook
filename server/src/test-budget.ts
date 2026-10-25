import { availableParallelism, loadavg } from "node:os";

const CI_WORKERS = 2;
const MAX_WORKERS = 8;
const MAX_TIME_SCALE = 6;

type Env = Record<string, string | undefined>;

export type TestHost = { cores: number; load: number };

function currentHost(): TestHost {
  return { cores: availableParallelism(), load: loadavg()[0] ?? 0 };
}

function positive(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function testWorkers(env: Env = process.env, host: TestHost = currentHost()): number {
  const override = positive(env.VIDEOBOOK_TEST_WORKERS);
  if (override !== undefined) return Math.max(1, Math.floor(override));
  if (env.GITHUB_ACTIONS) return CI_WORKERS;
  const busyMultiples = Math.floor(host.load / host.cores);
  return Math.min(MAX_WORKERS, Math.max(2, host.cores - 2 - 2 * busyMultiples));
}

export function testTimeScale(env: Env = process.env, host: TestHost = currentHost()): number {
  const override = positive(env.VIDEOBOOK_TEST_TIME_SCALE);
  if (override !== undefined) return override;
  if (env.GITHUB_ACTIONS) return 1;
  const contention = (host.load + testWorkers(env, host)) / host.cores;
  return Math.min(MAX_TIME_SCALE, Math.max(1, Math.round(contention * 100) / 100));
}

export function testBudget(ms: number, scale: number = testTimeScale()): number {
  return Math.ceil(ms * scale);
}
