import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFs } from "clipfirst-fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECTS_DIR = resolve(__dirname, "../../projects");
export const PROJECTS_DIR = process.env.CLIPFIRST_PROJECTS_DIR ?? DEFAULT_PROJECTS_DIR;
export const fs = createFs({ projectsDir: PROJECTS_DIR });

export function createFsForTest(projectsDir: string) {
  return createFs({ projectsDir });
}
