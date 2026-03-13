import { createFs } from "clipfirst-fs";

const PROJECTS_DIR = process.env.CLIPFIRST_PROJECTS_DIR ?? "projects";
export const fs = createFs({ projectsDir: PROJECTS_DIR });

export function createFsForTest(projectsDir: string) {
  return createFs({ projectsDir });
}
