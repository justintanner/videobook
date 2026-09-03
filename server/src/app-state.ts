import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ApplicationStateStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

type StoredState = { values: Record<string, unknown> };

export const DEFAULT_APPLICATION_STATE_PATH = "runtime/app-state.json";

export function resolveApplicationStatePath(
  envValue: string | undefined,
  cwd: string = process.cwd(),
): string {
  const normalized = envValue?.trim();
  const raw = normalized ? normalized : DEFAULT_APPLICATION_STATE_PATH;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

const statePath = resolveApplicationStatePath(process.env.VIDEOBOOK_APP_STATE_PATH);

function parseStoredState(raw: string): StoredState {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { values: {} };
  const values = (parsed as { values?: unknown }).values;
  return typeof values === "object" && values !== null && !Array.isArray(values)
    ? { values: values as Record<string, unknown> }
    : { values: {} };
}

/**
 * A JSON file store that re-reads the file on every access. Other processes
 * write it too — `scripts/mint-x-token.mjs` drops freshly minted X tokens in
 * while the server runs — so nothing may be cached across calls.
 */
export function createFileApplicationState(path: string): ApplicationStateStore {
  let writeChain: Promise<void> = Promise.resolve();

  async function read(): Promise<StoredState> {
    try {
      return parseStoredState(await readFile(path, "utf8"));
    } catch {
      return { values: {} };
    }
  }

  async function write(key: string, value: unknown): Promise<void> {
    const state = await read();
    state.values[key] = value;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), "utf8");
    await rename(temporary, path);
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      const state = await read();
      return key in state.values ? state.values[key] as T : null;
    },
    set<T>(key: string, value: T): Promise<void> {
      const next = writeChain.then(() => write(key, value), () => write(key, value));
      writeChain = next.catch(() => undefined);
      return next;
    },
  };
}

export const appState: ApplicationStateStore = createFileApplicationState(statePath);
