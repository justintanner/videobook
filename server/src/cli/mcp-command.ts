import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolvePort } from "./args.js";
import { onePasswordSummary, onePasswordWarnings } from "./key-report.js";
import { connectUpstream, createRelayServer } from "./mcp-relay.js";
import { bookManager, scopedEngine } from "../engine.js";
import { logger } from "../logger.js";
import { createServer, serverInstructions } from "../server.js";
import { ServerAlreadyRunningError, inspectServerOwner, type ServerLockRecord } from "../server-lock.js";
import { startServer, type RunningServer } from "../serve.js";

function stdinEnded(): Promise<number> {
  return new Promise((resolveEnd) => {
    process.stdin.once("end", () => resolveEnd(0));
    process.stdin.once("close", () => resolveEnd(0));
  });
}

function signalled(): Promise<number> {
  return new Promise((resolveSignal) => {
    process.once("SIGINT", () => resolveSignal(0));
    process.once("SIGTERM", () => resolveSignal(0));
  });
}

function reportStdioError(error: Error): void {
  process.stderr.write(`videobook mcp: ${error.message}\n`);
}

function hydrationFailure(running: RunningServer): Promise<number> {
  return running.ready.then(
    () => new Promise<number>(() => undefined),
    (error: unknown) => {
      logger.error("startup-failed", { error, port: running.port });
      return 1;
    },
  );
}

async function relayTo(owner: ServerLockRecord): Promise<number> {
  const upstream = await connectUpstream(`${owner.url}/mcp`);
  const handle = serveStdio(() => createRelayServer(upstream, serverInstructions(owner.url)), { onerror: reportStdioError });
  process.stderr.write(`videobook mcp: relaying stdio to ${owner.url}/mcp (pid ${owner.pid})\n`);
  const code = await Promise.race([stdinEnded(), signalled()]);
  await handle.close();
  await upstream.close();
  return code;
}

async function startOwner(port: number): Promise<RunningServer> {
  try {
    return await startServer({ port, ui: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EADDRINUSE" || port === 0) throw error;
    process.stderr.write(`videobook mcp: port ${port} is busy; using a free port.\n`);
    return await startServer({ port: 0, ui: true });
  }
}

async function serveInProcess(running: RunningServer): Promise<number> {
  const instructions = serverInstructions(running.url);
  const handle = serveStdio(() => createServer(scopedEngine, bookManager, { instructions }), { onerror: reportStdioError });
  process.stderr.write(`videobook mcp: serving stdio; web UI and HTTP MCP at ${running.url}/ for library ${running.libraryDir}\n`);
  const keys = onePasswordSummary();
  if (keys) process.stderr.write(`videobook mcp: ${keys}\n`);
  for (const warning of onePasswordWarnings()) process.stderr.write(`videobook mcp: ${warning}\n`);
  const code = await Promise.race([stdinEnded(), signalled(), hydrationFailure(running)]);
  await handle.close();
  await running.close();
  return code;
}

async function ownOrRelay(port: number): Promise<number> {
  let running: RunningServer;
  try {
    running = await startOwner(port);
  } catch (error) {
    if (error instanceof ServerAlreadyRunningError && error.running.url) return relayTo(error.running);
    logger.error("startup-failed", { error, port });
    process.stderr.write(`videobook mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return serveInProcess(running);
}

export async function runMcpCommand(): Promise<number> {
  const owner = await inspectServerOwner(bookManager.rootDir);
  if (owner.kind === "running") return relayTo(owner.record);
  if (owner.kind === "unresponsive") {
    process.stderr.write(`videobook mcp: videobook (pid ${owner.record.pid}) holds ${bookManager.rootDir} but is not responding. Stop it first.\n`);
    return 1;
  }
  return ownOrRelay(resolvePort(process.env));
}
