import "dotenv/config";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { queue } from "./queue.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  }));
});

async function start(): Promise<void> {
  await queue.start();
  const PORT = process.env.PORT ?? 3001;
  app.listen(PORT, () => {
    console.log(`MCP server listening on http://127.0.0.1:${PORT}/mcp`);
  });
}

process.on("SIGINT", async () => {
  await queue.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await queue.stop();
  process.exit(0);
});

start();
