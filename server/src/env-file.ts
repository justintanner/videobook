import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "dotenv";

export type EnvFileUpdates = Readonly<Record<string, string | null>>;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const NEW_FILE_MODE = 0o600;
const NEW_DIRECTORY_MODE = 0o700;

function assignmentPattern(key: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "u");
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

export function formatEnvValue(value: string): string {
  if (!/[#'"\s]/u.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("\"")) return `"${value}"`;
  throw new Error("value cannot contain both single and double quotes");
}

function withoutAssignments(lines: string[], key: string): string[] {
  const pattern = assignmentPattern(key);
  return lines.filter((line) => !pattern.test(line));
}

function withAssignment(lines: string[], key: string, value: string): string[] {
  const pattern = assignmentPattern(key);
  const line = `${key}=${formatEnvValue(value)}`;
  const last = lines.reduce((found, candidate, index) => pattern.test(candidate) ? index : found, -1);
  if (last >= 0) return lines.map((candidate, index) => index === last ? line : candidate);
  return [...lines, line];
}

function splitLines(raw: string): string[] {
  if (raw === "") return [];
  const lines = raw.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

export function applyEnvUpdates(raw: string, updates: EnvFileUpdates): string {
  let lines = splitLines(raw);
  for (const [key, value] of Object.entries(updates)) {
    if (!KEY_PATTERN.test(key)) throw new Error(`${key} is not a valid environment variable name`);
    lines = value === null ? withoutAssignments(lines, key) : withAssignment(lines, key, value);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function readEnvValues(path: string): Record<string, string> {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function existingMode(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return NEW_FILE_MODE;
  }
}

export async function updateEnvFile(path: string, updates: EnvFileUpdates): Promise<void> {
  const raw = await readIfPresent(path);
  const next = applyEnvUpdates(raw ?? "", updates);
  await mkdir(dirname(path), { recursive: true, mode: NEW_DIRECTORY_MODE });
  const mode = raw === null ? NEW_FILE_MODE : await existingMode(path);
  const temporary = `${path}.tmp.${randomUUID()}`;
  await writeFile(temporary, next, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}
