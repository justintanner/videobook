import "dotenv/config";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { queue, reconcileQueueOnStartup } from "./queue.js";
import { fs, PROJECTS_DIR } from "./fs.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { initImageModels } from "./image-models.js";
import {
  cleanOrphanedQueuedTasks,
  cleanStaleLockRaceErrors,
  resetStaleCompletingTasks,
} from "./jobs/pending-task.js";

const app = express();
app.use(cors());
app.use("/files", express.static(PROJECTS_DIR, { dotfiles: "allow" }));
app.use(express.json({ limit: "500mb" }));

app.get("/api/manifest/:projectSlug/:assetId", async (req, res) => {
  const { projectSlug, assetId } = req.params;
  const result = await fs.getManifest(assetId, projectSlug, {
    includeDotfiles: true,
  });
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
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    }),
  );
});

async function start(): Promise<void> {
  registerAllJobHandlers(fs);
  await initImageModels();
  await queue.start();
  for (const project of await fs.listProjects()) {
    const check = await fs.checkSchemaVersion(project.slug);
    if (!check.ok) {
      console.error(
        `[startup] refusing to open ${project.slug}: ${check.reason}`,
      );
      console.error(
        "[startup] upgrade clipfirst (or roll back the project) before continuing.",
      );
      process.exit(1);
    }
    const aborted = await fs.recoverIncompleteOperations(project.slug);
    if (aborted > 0) {
      console.log(
        `[startup] aborted ${aborted} orphan operation(s) in ${project.slug}`,
      );
    }
  }
  const orphanedQueued = await cleanOrphanedQueuedTasks(fs);
  const staleCompleting = await resetStaleCompletingTasks(fs);
  const staleLockErrors = await cleanStaleLockRaceErrors(fs);
  if (orphanedQueued > 0 || staleCompleting > 0 || staleLockErrors > 0) {
    console.log(
      `[startup] sidecar cleanup: orphaned=${orphanedQueued} completing=${staleCompleting} lockErrors=${staleLockErrors}`,
    );
  }
  await reconcileQueueOnStartup();
  const PORT = process.env.PORT ?? 3001;
  app.listen(PORT, () => {
    console.log(`MCP server listening on http://127.0.0.1:${PORT}/mcp`);
  });
}

process.on("SIGINT", async () => {
  await queue.stop();
  fs.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await queue.stop();
  fs.close();
  process.exit(0);
});

start();
