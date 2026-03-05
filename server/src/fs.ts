import { createFs } from "clipfirst-fs";

const OUTPUT_DIR = process.env.CLIPFIRST_OUTPUT_DIR ?? "output";
export const fs = createFs({ outputDir: OUTPUT_DIR });

export function createFsForTest(outputDir: string) {
  return createFs({ outputDir });
}
