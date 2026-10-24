import { createRequire } from "node:module";
import { SCHEMA_VERSION } from "videobook-engine/catalog-metadata";
import { redirectConsoleToStderr } from "./stdio-guard.js";
import {
  CliUsageError,
  applyFlagsToEnv,
  helpText,
  parseCli,
  type ParsedCli,
} from "./args.js";

type RunnableCli = Exclude<ParsedCli, { command: "version" } | { command: "help" }>;

const MCP_PROTOCOL_VERSION = "2026-07-28";

function versionLine(): string {
  const require = createRequire(import.meta.url);
  const own = require("../../package.json") as { version: string };
  const engine = require("videobook-engine/package.json") as { version: string };
  return `videobook ${own.version} (engine ${engine.version}, schema ${SCHEMA_VERSION}, mcp ${MCP_PROTOCOL_VERSION})`;
}

function parseOrReport(argv: string[]): ParsedCli | number {
  try {
    return parseCli(argv);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${helpText()}`);
    return 2;
  }
}

async function runCommand(parsed: RunnableCli): Promise<number> {
  switch (parsed.command) {
    case "serve": {
      const { runServeCommand } = await import("./serve-command.js");
      return runServeCommand(parsed.flags);
    }
    case "mcp": {
      const { runMcpCommand } = await import("./mcp-command.js");
      return runMcpCommand();
    }
    case "run": {
      const { runToolCommand } = await import("./run-command.js");
      return runToolCommand(parsed.flags, parsed.tool, parsed.toolArgs);
    }
    case "tools": {
      const { runToolsCommand } = await import("./run-command.js");
      return runToolsCommand();
    }
    case "gc-books": {
      const { runGcBooksCommand } = await import("./run-command.js");
      return runGcBooksCommand();
    }
    case "doctor": {
      const { runDoctorCommand } = await import("./doctor-command.js");
      return runDoctorCommand(parsed.flags);
    }
    case "setup": {
      const { runSetupCommand } = await import("./setup-command.js");
      return runSetupCommand(parsed.flags);
    }
    case "config": {
      const { runConfigCommand } = await import("./config-command.js");
      return runConfigCommand(parsed);
    }
  }
}

async function loadDotenv(): Promise<void> {
  const { getDefaultSecretStore } = await import("../env-secrets.js");
  getDefaultSecretStore().loadDotenv();
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseOrReport(argv);
  if (typeof parsed === "number") return parsed;
  if (parsed.command === "help") {
    process.stdout.write(helpText());
    return 0;
  }
  if (parsed.command === "version") {
    process.stdout.write(`${versionLine()}\n`);
    return 0;
  }
  applyFlagsToEnv(parsed.flags, process.env, process.cwd());
  if (parsed.command !== "serve") redirectConsoleToStderr();
  if (parsed.command !== "setup" && parsed.command !== "config") await loadDotenv();
  try {
    return await runCommand(parsed);
  } finally {
    if (parsed.command === "run" || parsed.command === "mcp") {
      const { flushHarCaptures } = await import("../har-capture.js");
      await flushHarCaptures();
    }
  }
}

function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolveFlush) => stream.write("", () => resolveFlush()));
}

function exitOnBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    process.exit(0);
  });
}

export async function runCli(argv: string[]): Promise<void> {
  exitOnBrokenPipe(process.stdout);
  let code: number;
  try {
    code = await main(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    code = 1;
  }
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}
