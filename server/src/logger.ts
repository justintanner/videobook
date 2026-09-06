import { diagnosticRecord, type DiagnosticEvent, type DiagnosticFields } from "./diagnostics.js";

type LogLevelName = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevelName, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

interface LogSink {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

const consoleSink: LogSink = {
  error: (...args) => {
    console.error(...args);
  },
  warn: (...args) => {
    console.warn(...args);
  },
  info: (...args) => {
    console.log(...args);
  },
  debug: (...args) => {
    console.debug(...args);
  },
};

function parseLevel(value: string | undefined): LogLevelName | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized in LEVEL_RANK) return normalized as LogLevelName;
  return null;
}

export function resolveLogLevel(
  env: NodeJS.ProcessEnv = process.env,
): LogLevelName {
  const explicit = parseLevel(env.VIDEOBOOK_LOG_LEVEL);
  if (explicit) return explicit;
  if (env.VITEST && env.VIDEOBOOK_TEST_LOG !== "1") return "error";
  return "info";
}

let currentLevel = resolveLogLevel();
let currentSink: LogSink = consoleSink;

export function configureLoggerForTests(options: {
  level?: LogLevelName;
  sink?: LogSink;
}): void {
  if (options.level !== undefined) currentLevel = options.level;
  if (options.sink !== undefined) currentSink = options.sink;
}

export function resetLoggerForTests(): void {
  currentLevel = resolveLogLevel();
  currentSink = consoleSink;
}

function enabled(level: LogLevelName): boolean {
  return LEVEL_RANK[currentLevel] >= LEVEL_RANK[level];
}

function emit(level: Exclude<LogLevelName, "silent">, event: DiagnosticEvent, fields?: DiagnosticFields): void {
  if (!enabled(level)) return;
  const record = diagnosticRecord(event, fields);
  if (record.event === "server-listening" && typeof record.port === "number") {
    currentSink[level](`MCP server listening on http://127.0.0.1:${record.port}/mcp`);
    return;
  }
  currentSink[level](`[${record.event}] ${JSON.stringify(record)}`);
}

export const logger = {
  error: (event: DiagnosticEvent, fields?: DiagnosticFields): void => emit("error", event, fields),
  warn: (event: DiagnosticEvent, fields?: DiagnosticFields): void => emit("warn", event, fields),
  info: (event: DiagnosticEvent, fields?: DiagnosticFields): void => emit("info", event, fields),
  debug: (event: DiagnosticEvent, fields?: DiagnosticFields): void => emit("debug", event, fields),
};
