import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine, IndexManifest, Result } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import {
  availablePort,
  record,
  resultValue,
  startProcess,
  stopProcess,
  waitForHttp,
  type StartedProcess,
} from "./e2e-harness.js";

const BOOK = '<img src=x onerror="window.__xssBook=1"><i>hostile book</i>';
const BOOK_SLUG = "img-src-x-onerror-window-xssbook-1-i-hostile-book-i";
const LABEL =
  '<img src=x onerror="window.__xssLabel=1"><b>hostile label</b> hostile-label-marker';
const EXCERPT =
  '<script>window.__xssExcerpt=1</script><img src=x onerror="window.__xssExcerpt=2"> hostile-excerpt-marker <a href="javascript:window.__xssExcerpt=3">link</a>';
const MCP_ROUNDTRIP_MS = 15_000;

const manifest: IndexManifest = {
  manifestId: "hostile-lexical-v1",
  provider: "fixture",
  modelId: "fixture",
  modelRevision: "1",
  license: "test",
  embeddingSpace: "hostile-lexical-space",
  dimensions: 3,
  modalities: ["visual", "metadata"],
  supportedLanguages: ["en"],
  preprocessingVersion: "1",
  extractorVersion: "1",
  createdAt: 1,
};

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC",
  "base64",
);

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function seedHostileBook(engine: Engine): Promise<string> {
  const artifact = value(await engine.artifacts.create("image", LABEL));
  value(await engine.files.write(artifact.artifactId, "original.png", png));
  const source = value(await engine.files.manifest(artifact.artifactId))
    .files[0]!;
  value(engine.temporalSearch.manifests.register(manifest));
  value(
    engine.temporalSearch.commitBatch({
      artifactId: artifact.artifactId,
      objectHash: source.objectHash,
      manifestId: manifest.manifestId,
      generation: "hostile-generation",
      phase: "lexical",
      maxUnits: 1,
      observations: [
        {
          artifactId: artifact.artifactId,
          objectHash: source.objectHash,
          sourcePath: source.name,
          kind: "frame",
          segmentationVersion: "1",
          texts: [{ kind: "description", language: "en", text: EXCERPT }],
          embeddings: [
            {
              modality: "visual",
              embeddingSpace: manifest.embeddingSpace,
              vector: [1, 0, 0],
              sourceHash: source.objectHash,
            },
          ],
          fingerprints: [],
        },
      ],
      coveredRanges: [],
      totalUnits: 1,
      complete: true,
    }),
  );
  value(
    engine.temporalSearch.activate(manifest.manifestId, "hostile-generation"),
  );
  value(await engine.temporalSearch.prepare());
  return artifact.artifactId;
}

describe("hostile search content across browser surfaces", () => {
  let rootDir = "";
  let mcpProcess: StartedProcess | undefined;
  let viteProcess: StartedProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let appUrl = "";
  let bookId = "";
  let artifactId = "";
  const pageErrors: string[] = [];

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-hostile-search-e2e-"));
    const libraryDir = join(rootDir, "books");
    const books = new BookManager({ libraryDir });
    await books.ready();
    bookId = value(await books.create(BOOK)).bookId;
    artifactId = await seedHostileBook(value(books.get(bookId)).engine);
    await books.close();

    const mcpPort = await availablePort();
    const vitePort = await availablePort();
    const mcpOrigin = `http://127.0.0.1:${mcpPort}`;
    appUrl = `http://127.0.0.1:${vitePort}`;
    mcpProcess = startProcess(["--import", "tsx", "server/src/index.ts"], {
      ...process.env,
      PORT: String(mcpPort),
      VIDEOBOOK_APP_STATE_PATH: join(rootDir, "runtime", "app-state.json"),
      VIDEOBOOK_LIBRARY_DIR: libraryDir,
      VIDEOBOOK_MODEL_DOWNLOAD: "disabled",
      VIDEOBOOK_MODEL_CACHE_DIR: join(rootDir, "missing-models"),
    });
    await waitForHttp(`${mcpOrigin}/healthz`, mcpProcess, 200);
    const client = new Client(
      { name: "videobook-hostile-search-e2e", version: "1.0.0" },
      {
        capabilities: {},
        supportedProtocolVersions: ["2026-07-28"],
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`)),
    );
    const listedBooks = resultValue(
      await client.callTool({
        name: "list_books",
        arguments: { sort: "newest" },
      }),
    );
    const listedBook = (Array.isArray(listedBooks) ? listedBooks : [])
      .map(record)
      .find((entry) => entry?.bookId === bookId);
    expect(listedBook?.name).toBe(BOOK_SLUG);
    const notebooks = resultValue(
      await client.callTool({
        name: "list_notebooks",
        arguments: { book_id: bookId },
      }),
    );
    const notebook = (Array.isArray(notebooks) ? notebooks : [])
      .map(record)
      .find(Boolean);
    const notebookId = typeof notebook?.id === "string" ? notebook.id : "";
    if (!notebookId) throw new Error("Could not find the fixture notebook");
    resultValue(
      await client.callTool({
        name: "create_notebook_cell",
        arguments: {
          book_id: bookId,
          notebook_id: notebookId,
          cell: {
            type: "image",
            label: "img-slot",
            slot: { row: 0, column: 0 },
          },
        },
      }),
    );
    await client.close();

    viteProcess = startProcess(
      [
        join(process.cwd(), "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        String(vitePort),
      ],
      { ...process.env, VIDEOBOOK_SERVER_URL: mcpOrigin, VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, "vite-cache") },
    );
    await waitForHttp(appUrl, viteProcess, 200);
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
  }, 120_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await stopProcess(viteProcess);
    await stopProcess(mcpProcess);
    if (rootDir)
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function executedMarkers(target: Page): Promise<string[]> {
    return await target.evaluate(() =>
      Object.keys(window).filter((key) => key.startsWith("__xss")),
    );
  }

  async function activeInjectedElements(target: Page): Promise<number> {
    return await target.evaluate(
      () =>
        document.querySelectorAll(
          'img[src="x"], [onerror], [onload], svg[onload], a[href^="javascript:"]',
        ).length,
    );
  }

  async function search(target: Page, query: string): Promise<void> {
    const input = target.getByLabel("Search library", { exact: true });
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await expect
      .poll(async () => await input.isEnabled(), { timeout: MCP_ROUNDTRIP_MS })
      .toBe(true);
    await input.fill(query);
    await input.press("Enter");
  }

  it("normalizes hostile project names and safely renders search matches in the chat picker", async () => {
    if (!page) throw new Error("Browser page was not initialized");
    await page.goto(appUrl, { waitUntil: "commit" });
    await page.getByLabel("Open Assets", { exact: true }).click();
    await search(page, "hostile-excerpt-marker");
    const card = page.locator(".media-library-asset");
    await card.first().waitFor({ state: "visible", timeout: MCP_ROUNDTRIP_MS });
    expect(await card.count()).toBe(1);
    expect(await card.locator("strong").textContent()).toBe(LABEL);
    expect(await card.locator(".media-library-asset-copy small").count()).toBe(0);
    expect(await card.locator(".media-library-asset-use").getAttribute("aria-label")).toBe(
      `Use ${LABEL} from ${BOOK_SLUG}`,
    );
    expect(await executedMarkers(page)).toEqual([]);
    expect(await activeInjectedElements(page)).toBe(0);
    expect(pageErrors).toEqual([]);
  }, 60_000);

  it("renders the owning project slug in the docked media library", async () => {
    if (!page) throw new Error("Browser page was not initialized");
    await page.goto(appUrl, { waitUntil: "commit" });
    const opener = page.locator(".cell-media-slot-library").first();
    await opener.waitFor({ state: "visible", timeout: 30_000 });
    await opener.click();
    const dialog = page.getByRole("region", { name: "Choose image media" });
    await dialog.waitFor({ state: "visible", timeout: MCP_ROUNDTRIP_MS });
    const asset = dialog.locator(".media-library-asset").first();
    await asset.waitFor({ state: "visible", timeout: MCP_ROUNDTRIP_MS });
    expect(await asset.locator("strong").textContent()).toBe(LABEL);
    expect(await asset.locator(".media-library-asset-copy small").count()).toBe(0);
    expect(
      await asset
        .locator("button[aria-label]")
        .last()
        .getAttribute("aria-label"),
    ).toBe(`Use ${LABEL} from ${BOOK_SLUG}`);
    expect(artifactId).toBeTruthy();
    expect(await executedMarkers(page)).toEqual([]);
    expect(await activeInjectedElements(page)).toBe(0);
    expect(pageErrors).toEqual([]);
  }, 60_000);
});
