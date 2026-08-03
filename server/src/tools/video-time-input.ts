import { z } from "zod";
import { parseTime } from "../time-parse.js";

export const videoTimestampSchema = z.union([
  z.number(),
  z.string().min(1),
]);

export function parseVideoTimestamp(
  value: string | number | undefined,
  name: string,
): number | undefined {
  try {
    const parsed = parseTime(value);
    if (value !== undefined && parsed === undefined) {
      throw new Error(`${name} is required`);
    }
    return parsed;
  } catch {
    throw new Error(`${name} must be seconds or a timestamp such as 15s or 1:30`);
  }
}
