/**
 * Defensive readers for provider API keys.
 *
 * Tool tests set `process.env.KIE_API_KEY = "test-key"` and enqueue a job
 * without waiting for it. `afterEach` restores the real key, then the
 * background worker dequeues and bills real money. These helpers reject
 * placeholder values at the API call site so the worker fails closed.
 *
 * Job handlers MUST go through these — never read `process.env.*_API_KEY`
 * directly.
 */

const PLACEHOLDER_PATTERNS = [/^test-/i, /^sk-test-/i];

export function isPlaceholderApiKey(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

export function requireApiKey(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is not set`);
  if (isPlaceholderApiKey(value)) {
    throw new Error(
      `${name} is a placeholder ("${value}"). Refusing to call the real API. ` +
      `If a test enqueued this job, the worker dequeued it after the test ended — fix the test, not this guard.`,
    );
  }
  return value;
}

export function getApiKey(name: string): string | null {
  const value = process.env[name];
  if (!value) return null;
  if (isPlaceholderApiKey(value)) return null;
  return value;
}
