import "./load-env.js";
import cors from "cors";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localArchiveDir } from "./archive-store.js";
import { bookManager, fs as scopedBookEngine } from "./fs.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { uploadLocalStream } from "./local-upload.js";
import { queue } from "./queue.js";
import { loadAndArmAll, stopScheduler } from "./scheduled-posts.js";
import { createServer } from "./server.js";

const app = express();

app.use(cors());
app.use("/archive-files", express.static(localArchiveDir(), { dotfiles: "allow" }));

app.get("/healthz", async (_req, res) => {
  await bookManager.ready();
  res.json({
    ok: true,
    service: "videobook",
    engineVersion: "3.0.0",
    schemaVersion: 5,
  });
});

async function engineForBook(
  bookId: string,
): Promise<ReturnType<typeof bookManager.get>> {
  await bookManager.ready();
  return bookManager.get(bookId);
}

app.get(/^\/files\/([^/]+)\/([^/]+)\/(.+)$/, async (req, res) => {
  const bookId = String(req.params[0]);
  const artifactId = String(req.params[1]);
  const filename = String(req.params[2]);
  const book = await engineForBook(bookId);
  if (!book.ok) {
    res.status(404).json({ error: book.error.message });
    return;
  }
  const result = await book.value.engine.files.read(artifactId, filename);
  if (!result.ok) {
    res.status(result.error.code === "NOT_FOUND" ? 404 : 400).json({ error: result.error.message });
    return;
  }
  res.type(filename).send(result.value);
});

app.post("/api/books/:bookId/upload", async (req, res) => {
  const filename = typeof req.query.filename === "string" ? req.query.filename : "";
  if (!filename) {
    res.status(400).json({ error: "Missing filename" });
    return;
  }
  const book = await engineForBook(req.params.bookId);
  if (!book.ok) {
    res.status(404).json({ error: book.error.message });
    return;
  }
  const targetAssetId = typeof req.query.targetAssetId === "string" ? req.query.targetAssetId : undefined;
  const result = await uploadLocalStream(book.value.engine, {
    bookId: book.value.bookId,
    filename,
    stream: req,
    targetAssetId,
  });
  if (!result.ok) {
    res.status(result.statusCode).json({ error: result.message });
    return;
  }
  res.json(result.value);
});

app.use(express.json({ limit: "500mb" }));

app.get("/api/books/:bookId/artifacts/:artifactId/manifest", async (req, res) => {
  const book = await engineForBook(req.params.bookId);
  if (!book.ok) {
    res.status(404).json({ error: book.error.message });
    return;
  }
  const result = await book.value.engine.files.manifest(req.params.artifactId, {
    includeDotfiles: true,
  });
  if (!result.ok) {
    res.status(result.error.code === "NOT_FOUND" ? 404 : 400).json({ error: result.error.message });
    return;
  }
  res.json(result.value);
});

app.post("/mcp", async (req, res) => {
  const server = createServer(scopedBookEngine, bookManager);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
  await bookManager.ready();
  registerAllJobHandlers(scopedBookEngine);
  await queue.start();
  await loadAndArmAll();
  const port = process.env.PORT ?? 3001;
  app.listen(port, () => {
    console.log(`MCP server listening on http://127.0.0.1:${port}/mcp`);
  });
}

async function shutdown(): Promise<void> {
  let exitCode = 0;
  try {
    stopScheduler();
    await queue.stop();
    await bookManager.close();
  } catch (error) {
    console.error("[shutdown] cleanup failed:", error);
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((error) => {
  console.error("[startup] fatal:", error);
  process.exit(1);
});
