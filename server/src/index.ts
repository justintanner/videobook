import "./load-env.js";
import cors from "cors";
import express from "express";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { SCHEMA_VERSION } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { stopAceServer } from "./acestep/process.js";
import { localArchiveDir } from "./archive-store.js";
import { bookManager, fs as scopedBookEngine } from "./fs.js";
import { ensureDancingWorkflow } from "./dancing-workflow.js";
import { registerAllJobHandlers } from "./jobs/index.js";
import { reconcileAwaitingNotebookOutputs } from "./jobs/run-notebook.js";
import { uploadLocalStream } from "./local-upload.js";
import { queue } from "./queue.js";
import { searchReferenceStore } from "./search-reference-store.js";
import { loadAndArmAll, stopScheduler } from "./scheduled-posts.js";
import { createHttpHandler } from "./server.js";
import { parseHttpByteRange } from "./http-byte-range.js";

const require = createRequire(import.meta.url);
const enginePackage = require("videobook-engine/package.json") as {
  version: string;
};
const app = express();
const SEARCH_REFERENCE_LIMIT_BYTES = 500 * 1024 * 1024;
const mcpHandler = createHttpHandler(scopedBookEngine, bookManager);
const handleMcpRequest = toNodeHandler(mcpHandler);

function limitUploadBytes(maxBytes: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        callback(new Error("Search reference exceeds the 500 MB limit"));
        return;
      }
      callback(null, chunk);
    },
  });
}

app.use(cors());
app.use("/archive-files", express.static(localArchiveDir(), { dotfiles: "allow" }));

app.get("/healthz", async (_req, res) => {
  await bookManager.ready();
  res.json({
    ok: true,
    service: "videobook",
    engineVersion: enginePackage.version,
    schemaVersion: SCHEMA_VERSION,
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
  res.type(filename);
  res.setHeader("Accept-Ranges", "bytes");
  const rangeHeader = req.headers.range;
  if (!rangeHeader) {
    res.send(result.value);
    return;
  }
  const range = parseHttpByteRange(rangeHeader, result.value.byteLength);
  if (!range.ok) {
    res.setHeader("Content-Range", `bytes */${result.value.byteLength}`);
    res.sendStatus(416);
    return;
  }
  res.status(206);
  res.setHeader(
    "Content-Range",
    `bytes ${range.start}-${range.end}/${result.value.byteLength}`,
  );
  res.send(result.value.subarray(range.start, range.end + 1));
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

app.post("/api/search-references", async (req, res) => {
  const filename = typeof req.query.filename === "string" ? req.query.filename : "";
  const bookId = typeof req.query.bookId === "string" ? req.query.bookId : "";
  const kind = req.query.kind === "image" || req.query.kind === "video"
    ? req.query.kind
    : null;
  if (!filename || !bookId || !kind) {
    res.status(400).json({ error: "filename, bookId, and kind are required" });
    return;
  }
  const book = await engineForBook(bookId);
  if (!book.ok) {
    res.status(404).json({ error: book.error.message });
    return;
  }
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (declaredLength > SEARCH_REFERENCE_LIMIT_BYTES) {
    res.status(413).json({ error: "Search reference exceeds the 500 MB limit" });
    return;
  }
  const uploadRoot = await mkdtemp(join(tmpdir(), "videobook-search-upload-"));
  const suffix = extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const uploadPath = join(uploadRoot, `reference${suffix}`);
  try {
    await pipeline(
      req,
      limitUploadBytes(SEARCH_REFERENCE_LIMIT_BYTES),
      createWriteStream(uploadPath, { flags: "wx" }),
    );
    const result = await queue.enqueueAndWait(
      `prepare-search-reference-${uuidv7()}`,
      {
        type: "prepare_search_reference",
        bookId,
        mediaKind: kind,
        name: filename,
        uploadPath,
        cleanupRoot: uploadRoot,
      },
      15 * 60_000,
    );
    res.json(result);
  } catch (cause) {
    await rm(uploadRoot, { recursive: true, force: true });
    const message = cause instanceof Error ? cause.message : String(cause);
    res.status(message.includes("500 MB limit") ? 413 : 400).json({
      error: message,
    });
  }
});

app.delete("/api/search-references/:referenceId", (req, res) => {
  res.json({
    released: searchReferenceStore.release(req.params.referenceId),
  });
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

app.all("/mcp", (req, res) => {
  void handleMcpRequest(req, res, req.body);
});

async function start(): Promise<void> {
  await bookManager.ready();
  registerAllJobHandlers(scopedBookEngine);
  if (process.env.VIDEOBOOK_DEV_FIXTURES === "1") {
    await ensureDancingWorkflow(bookManager);
  }
  await queue.start();
  for (const book of bookManager.list()) {
    const selected = bookManager.get(book.bookId);
    if (!selected.ok) continue;
    await reconcileAwaitingNotebookOutputs(
      selected.value.engine,
      selected.value.bookId,
    );
  }
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
    await mcpHandler.close();
    await queue.stop();
    await stopAceServer();
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
