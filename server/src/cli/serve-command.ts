import type { ServeFlags } from "./args.js";
import { resolvePort } from "./args.js";
import { onePasswordSummary, onePasswordWarnings } from "./key-report.js";
import { openInBrowser } from "./open-browser.js";
import { logger } from "../logger.js";
import { SERVER_VERSION } from "../server.js";
import { ServerAlreadyRunningError } from "../server-lock.js";
import { installSignalHandlers, startServer, type RunningServer } from "../serve.js";

function uiLine(running: RunningServer): string {
  if (running.uiStatus === "served") return `${running.url}/`;
  if (running.uiStatus === "disabled") return "off (--headless)";
  return `not built at ${running.uiDir}; serving MCP and API only`;
}

function printBanner(running: RunningServer): void {
  const keys = onePasswordSummary();
  process.stdout.write([
    `videobook ${SERVER_VERSION}`,
    `Library  ${running.libraryDir}`,
    `UI       ${uiLine(running)}`,
    `MCP      ${running.mcpUrl}`,
    ...(keys ? [`Keys     ${keys}`] : []),
    "Agents   claude mcp add videobook -- videobook mcp",
    "",
  ].join("\n"));
  for (const warning of onePasswordWarnings()) process.stderr.write(`videobook: ${warning}\n`);
}

function reportStartupFailure(error: unknown, port: number): number {
  if (error instanceof ServerAlreadyRunningError) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  logger.error("startup-failed", { error, port });
  if ((error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
    process.stderr.write(`Port ${port} is already in use by another process; pass --port <n>.\n`);
  }
  return 1;
}

function hydrationFailure(running: RunningServer): Promise<number> {
  return running.ready.then(
    () => new Promise<number>(() => undefined),
    async (error: unknown) => {
      logger.error("startup-failed", { error, port: running.port });
      await running.close().catch(() => undefined);
      return 1;
    },
  );
}

export async function runServeCommand(flags: ServeFlags): Promise<number> {
  const port = resolvePort(process.env);
  const starting = startServer({ port, ui: flags.ui });
  const stopped = new Promise<number>((resolveStop) => installSignalHandlers(starting, resolveStop));
  let running: RunningServer;
  try {
    running = await starting;
  } catch (error) {
    return reportStartupFailure(error, port);
  }
  printBanner(running);
  if (flags.open && running.uiStatus === "served") openInBrowser(`${running.url}/`);
  return Promise.race([stopped, hydrationFailure(running)]);
}
