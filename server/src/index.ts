import "dotenv/config";
import express from "express";
import cors from "cors";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { queue } from "./queue.js";
import { fs } from "./fs.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { initImageModels } from "./image-models.js";
import { cleanOrphanedQueuedTasks } from "./jobs/pending-task.js";

const PROJECTS_DIR = process.env.CLIPFIRST_PROJECTS_DIR ?? "projects";

const app = express();
app.use(cors());
app.use("/files", express.static(resolve(PROJECTS_DIR), { dotfiles: "allow" }));
app.use(express.json({ limit: "50mb" }));

app.get("/api/manifest/:projectSlug/:assetId", async (req, res) => {
  const { projectSlug, assetId } = req.params;
  const result = await fs.getManifest(assetId, projectSlug, { includeDotfiles: true });
  if (result.ok) {
    res.json(result.value);
  } else {
    const status = result.error.code === "NOT_FOUND" ? 404 : 400;
    res.status(status).json({ error: result.error.message });
  }
});

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
  registerAllJobHandlers(fs);
  await initImageModels();
  await queue.start();
  const cleaned = await cleanOrphanedQueuedTasks(fs);
  if (cleaned > 0) console.log(`[startup] cleaned ${cleaned} orphaned queued tasks`);
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
