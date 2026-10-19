import { createRequire } from "node:module";
import { SCHEMA_VERSION } from "videobook-engine/catalog-metadata";
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
    default:
      process.stderr.write(`videobook ${parsed.command} is not available yet.\n`);
      return 2;
  }
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
  await import("../load-env.js");
  return runCommand(parsed);
}

function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolveFlush) => stream.write("", () => resolveFlush()));
}

export async function runCli(argv: string[]): Promise<void> {
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
