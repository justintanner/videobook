import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ApplicationStateStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

type StoredState = { values: Record<string, unknown> };

const statePath = resolve(
  process.env.VIDEOBOOK_APP_STATE_PATH ?? "runtime/app-state.json",
);

class FileApplicationState implements ApplicationStateStore {
  private loaded: Promise<StoredState> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | null> {
    const state = await this.read();
    return key in state.values ? state.values[key] as T : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const write = async (): Promise<void> => {
      const state = await this.read();
      state.values[key] = value;
      const directory = dirname(statePath);
      await mkdir(directory, { recursive: true });
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state), "utf8");
      await rename(temporary, statePath);
    };
    const next = this.writeChain.then(write, write);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<StoredState> {
    if (!this.loaded) {
      this.loaded = readFile(statePath, "utf8")
        .then((raw) => {
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { values: {} };
          const values = (parsed as { values?: unknown }).values;
          return typeof values === "object" && values !== null && !Array.isArray(values)
            ? { values: values as Record<string, unknown> }
            : { values: {} };
        })
        .catch(() => ({ values: {} }));
    }
    return this.loaded;
  }
}

export const appState: ApplicationStateStore = new FileApplicationState();
