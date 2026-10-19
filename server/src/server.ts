import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { createRequire } from "node:module";
import type { Engine } from "videobook-engine";
import type { BookManager } from "./book-manager.js";
import { registerAllTools } from "./tools/index.js";
import { bookManager, scopedEngine as defaultFs } from "./engine.js";
import { allowsHttpRequest } from "./http-access.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const SERVER_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

function createServer(
  engine: Engine = defaultFs,
  books: BookManager = bookManager,
): McpServer {
  const server = new McpServer({
    name: "videobook",
    version: SERVER_VERSION,
  }, {
    supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
  });

  registerAllTools(server, engine, books);

  return server;
}

export function createHttpHandler(
  engine: Engine | (() => Engine) = defaultFs,
  books: BookManager = bookManager,
): McpHttpHandler {
  const resolveEngine = typeof engine === "function" ? engine : () => engine;
  const handler = createMcpHandler(() => createServer(resolveEngine(), books), {
    legacy: "reject",
  });
  return {
    ...handler,
    async fetch(request, options) {
      const urlHost = new URL(request.url).host;
      if (!allowsHttpRequest(urlHost, null, null) || !allowsHttpRequest(
        request.headers.get("host") ?? urlHost,
        request.headers.get("origin"),
        request.headers.get("sec-fetch-site"),
      )) {
        return Response.json({ error: "HTTP request origin or host is not allowed" }, { status: 403 });
      }
      return handler.fetch(request, options);
    },
  };
}
