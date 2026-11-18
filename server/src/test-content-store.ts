import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { ContentStore } from "videobook-engine";

export interface DirectoryContentStore extends ContentStore {
  keys(): Promise<string[]>;
  failNextDeletes(count: number): void;
}

export function directoryContentStore(root: string): DirectoryContentStore {
  const file = (key: string) => join(root, ...key.split("/"));
  let deleteFailures = 0;
  return {
    head: async (key) => {
      try {
        return { exists: true, size: (await stat(file(key))).size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
        throw error;
      }
    },
    uploadFile: async (key, sourcePath) => {
      await mkdir(dirname(file(key)), { recursive: true });
      await copyFile(sourcePath, file(key));
    },
    downloadFile: async (key, destinationPath) => {
      await copyFile(file(key), destinationPath);
    },
    delete: async (key) => {
      if (deleteFailures > 0) {
        deleteFailures -= 1;
        throw new Error(`Remote storage unavailable while deleting ${key}`);
      }
      await rm(file(key), { force: true });
    },
    keys: async () => {
      const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
        .sort();
    },
    failNextDeletes: (count) => {
      deleteFailures = count;
    },
  };
}
