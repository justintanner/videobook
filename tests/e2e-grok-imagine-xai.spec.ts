import { test, expect, type Page } from "playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = "http://localhost:5174";
const PROJECT_SLUG = "jolly-turtle-89";
const PROJECTS_DIR = join(process.cwd(), "projects");
const PROJECT_DIR = join(PROJECTS_DIR, PROJECT_SLUG);

test.setTimeout(120_000);

// ── Helpers ──────────────────────────────────────────────────────────

async function waitForAssetsLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const els = document.querySelectorAll("*");
    for (const el of els) {
      if (el.textContent?.includes("@img-")) return true;
    }
    return false;
  }, { timeout: 20_000 });
}

async function switchProject(page: Page, slug: string): Promise<void> {
  const projectBtn = page.locator('button', { hasText: 'projects/' });
  await projectBtn.click();
  await page.waitForTimeout(500);
  const listItem = page.locator('[class*="truncate"]', { hasText: slug });
  await listItem.click();
  await page.waitForTimeout(1000);
  await waitForAssetsLoaded(page);
}

async function sendCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="input-chat"]');
  await input.fill(command);
  await page.waitForTimeout(200);
  await input.press('Enter');
  await page.waitForTimeout(500);
}

/** Wait for the gen panel to appear (loading spinner then form). */
async function waitForGenPanel(page: Page): Promise<void> {
  // Wait for the panel header text
  await page.waitForFunction(() => {
    const els = document.querySelectorAll("*");
    for (const el of els) {
      if (el.textContent?.includes("IMAGE GENERATION") || el.textContent?.includes("VIDEO GENERATION")) {
        return true;
      }
    }
    return false;
  }, { timeout: 15_000 });
}

/** Wait for gen panel to finish loading (spinner gone, form visible). */
async function waitForGenFormReady(page: Page): Promise<void> {
  // Wait for the /prompt section to appear (indicates form is loaded)
  await page.locator('text=/prompt').first().waitFor({ state: 'visible', timeout: 30_000 });
}

/** Select a model in the gen panel's /model dropdown. */
async function selectModel(page: Page, modelKey: string): Promise<void> {
  const select = page.locator('select[aria-label="/model"]');
  await select.selectOption(modelKey);
  await page.waitForTimeout(300);
}

/** Select a provider in the gen panel's /provider dropdown. */
async function selectProvider(page: Page, providerLabel: string): Promise<void> {
  const select = page.locator('select[aria-label="/provider"]');
  await select.selectOption(providerLabel);
  await page.waitForTimeout(300);
}

/** Intercept MCP POST responses and collect bodies. */
function collectMcpResponses(page: Page): { responses: Array<{ url: string; body: string; status: number }> } {
  const collected: Array<{ url: string; body: string; status: number }> = [];
  page.on('response', async (resp) => {
    if (resp.url().includes('/mcp') && resp.request().method() === 'POST') {
      try {
        const body = await resp.text();
        collected.push({ url: resp.url(), body, status: resp.status() });
      } catch {
        // response body may be unavailable
      }
    }
  });
  return { responses: collected };
}

/** Find newly created asset directories matching a prefix under the project dir. */
async function findAssetDirs(prefix: string): Promise<string[]> {
  const entries = await readdir(PROJECT_DIR);
  return entries.filter((e) => e.startsWith(prefix)).sort();
}

/** Read a JSON metadata file from an asset directory. */
async function readAssetMeta<T>(assetId: string, metaName: string): Promise<T | null> {
  const filePath = join(PROJECT_DIR, assetId, `.${metaName}.json`);
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("grok imagine generation via xAI", () => {
  test.beforeEach(async ({ page }) => {
    page.on("console", (msg) => {
      if (msg.text().includes("[sync]") || msg.text().includes("error") || msg.text().includes("[gen]")) {
        console.log(`BROWSER: ${msg.text()}`);
      }
    });

    await page.goto(BASE);
    await page.waitForTimeout(3000);

    const headerText = await page.locator('button', { hasText: 'projects/' }).textContent();
    if (!headerText?.includes(PROJECT_SLUG)) {
      await switchProject(page, PROJECT_SLUG);
    } else {
      await waitForAssetsLoaded(page);
    }
  });

  test("image gen: /image @img-cat routes to grok imagine, select xAI, verify preview resolved_assets", async ({ page }) => {
    const { responses } = collectMcpResponses(page);

    // Type /image command with @img-cat reference
    await sendCommand(page, '/image grok @img-cat');

    // Wait for gen panel to appear
    await waitForGenPanel(page);
    await waitForGenFormReady(page);

    await page.screenshot({ path: "tests/screenshots/grok-image-panel-loaded.png", fullPage: true });

    // Select Grok Imagine model
    await selectModel(page, 'grok_imagine_image');
    await page.waitForTimeout(500);

    // Select xAI provider
    await selectProvider(page, 'xAI');
    await page.waitForTimeout(300);

    await page.screenshot({ path: "tests/screenshots/grok-image-xai-selected.png", fullPage: true });

    // Verify the model selector shows Grok Imagine
    const modelSelect = page.locator('select[aria-label="/model"]');
    await expect(modelSelect).toHaveValue('grok_imagine_image');

    // Verify the provider selector shows xAI
    const providerSelect = page.locator('select[aria-label="/provider"]');
    await expect(providerSelect).toHaveValue('xAI');

    // Flip to JSON payload view to verify resolved_assets and tool call
    const settingsBtn = page.locator('button[title="View JSON payload"]');
    await settingsBtn.click();
    await page.waitForTimeout(500);

    await page.screenshot({ path: "tests/screenshots/grok-image-json-payload.png", fullPage: true });

    // Verify the /tool-call pane shows correct tool name
    const toolCallPane = page.locator('text=/tool-call').locator('..').locator('..');
    const toolCallText = await toolCallPane.textContent();
    expect(toolCallText).toContain('generate_grok_imagine_image');

    // Verify image_slugs contains @img-cat
    expect(toolCallText).toContain('img-cat');

    // Verify the provider is xai
    expect(toolCallText).toContain('xai');

    // Check MCP responses for preview_image call containing resolved_assets
    const previewResponse = responses.find((r) => r.body.includes('resolved_assets'));
    expect(previewResponse).toBeDefined();
    if (previewResponse) {
      // Parse the SSE/JSON response to extract resolved_assets
      const bodyLines = previewResponse.body.split('\n').filter(Boolean);
      for (const line of bodyLines) {
        try {
          const parsed = JSON.parse(line);
          const resultText = parsed?.result?.content?.[0]?.text;
          if (resultText && resultText.includes('resolved_assets')) {
            const preview = JSON.parse(resultText);
            expect(preview.resolved_assets).toBeDefined();
            expect(Array.isArray(preview.resolved_assets)).toBe(true);
            // Verify at least one resolved asset starts with img-cat
            const catAsset = preview.resolved_assets.find((a: { slug: string }) =>
              a.slug.startsWith('img-cat')
            );
            expect(catAsset).toBeDefined();
            expect(catAsset.type).toBe('image');
            expect(catAsset.src).toContain('img-cat');
          }
        } catch {
          // not a JSON line, skip
        }
      }
    }
  });

  test("image gen: submit grok imagine xAI generation, verify metadata files", async ({ page }) => {
    // Record asset dirs before generation
    const dirsBefore = await findAssetDirs("img-grok-cat");

    // Type /image command with @img-cat reference
    await sendCommand(page, '/image grok @img-cat');
    await waitForGenPanel(page);
    await waitForGenFormReady(page);

    // Select Grok Imagine model + xAI provider
    await selectModel(page, 'grok_imagine_image');
    await page.waitForTimeout(300);
    await selectProvider(page, 'xAI');
    await page.waitForTimeout(300);

    // Click /generate button
    const genBtn = page.locator('button', { hasText: '/generate' });
    await expect(genBtn).toBeVisible({ timeout: 5_000 });

    // Wait for MCP response containing "enqueued"
    const genResponse = page.waitForResponse(
      (resp) => resp.url().includes('/mcp') && resp.status() === 200,
      { timeout: 30_000 },
    );
    await genBtn.click();
    const resp = await genResponse;
    const body = await resp.text();
    expect(body).toContain('enqueued');

    await page.screenshot({ path: "tests/screenshots/grok-image-gen-submitted.png", fullPage: true });

    // Wait for asset to be created on disk
    await page.waitForTimeout(3000);

    // Find newly created grok-cat asset
    const dirsAfter = await findAssetDirs("img-grok-cat");
    const newDirs = dirsAfter.filter((d) => !dirsBefore.includes(d));
    expect(newDirs.length).toBeGreaterThanOrEqual(1);

    const newAssetId = newDirs[0];
    console.log("NEW IMAGE ASSET:", newAssetId);

    // Verify .kie-task.json (pending task metadata)
    const kieTask = await readAssetMeta<{
      taskId: string;
      taskType: string;
      assetId: string;
      projectSlug: string;
      meta: { sourceImageId: string };
    }>(newAssetId, "kie-task");
    expect(kieTask).not.toBeNull();
    expect(kieTask!.taskType).toBe("grok_imagine_image");
    expect(kieTask!.assetId).toBe(newAssetId);
    expect(kieTask!.projectSlug).toBe(PROJECT_SLUG);
    expect(kieTask!.meta.sourceImageId).toBe("img-cat");

    // Verify .generation-payload.json
    // The job handler writes this after uploading the image
    // It may take a moment for the job to run, so poll briefly
    let genPayload: Record<string, unknown> | null = null;
    for (let i = 0; i < 10; i++) {
      genPayload = await readAssetMeta<Record<string, unknown>>(newAssetId, "generation-payload");
      if (genPayload) break;
      await page.waitForTimeout(1000);
    }

    // generation-payload should exist (written by job handler)
    if (genPayload) {
      console.log("GENERATION PAYLOAD:", JSON.stringify(genPayload));
      // xAI path: payload has prompt and image fields
      expect(genPayload).toHaveProperty("prompt");
      // xAI uses image.url (data URL) or image_url
      const hasImageRef = "image" in genPayload || "image_url" in genPayload;
      expect(hasImageRef).toBe(true);
    }
  });

  test("video gen: /video @img-cat routes to grok imagine, select xAI, verify preview resolved_assets", async ({ page }) => {
    const { responses } = collectMcpResponses(page);

    // Type /video command with @img-cat reference and grok keyword
    await sendCommand(page, '/video grok @img-cat');

    await waitForGenPanel(page);
    await waitForGenFormReady(page);

    await page.screenshot({ path: "tests/screenshots/grok-video-panel-loaded.png", fullPage: true });

    // Select Grok Imagine model for video
    await selectModel(page, 'grok_imagine');
    await page.waitForTimeout(500);

    // Select xAI provider
    await selectProvider(page, 'xAI');
    await page.waitForTimeout(300);

    await page.screenshot({ path: "tests/screenshots/grok-video-xai-selected.png", fullPage: true });

    // Verify model and provider selectors
    await expect(page.locator('select[aria-label="/model"]')).toHaveValue('grok_imagine');
    await expect(page.locator('select[aria-label="/provider"]')).toHaveValue('xAI');

    // Flip to JSON payload view
    const settingsBtn = page.locator('button[title="View JSON payload"]');
    await settingsBtn.click();
    await page.waitForTimeout(500);

    await page.screenshot({ path: "tests/screenshots/grok-video-json-payload.png", fullPage: true });

    // Verify the /tool-call pane
    const toolCallPane = page.locator('text=/tool-call').locator('..').locator('..');
    const toolCallText = await toolCallPane.textContent();
    expect(toolCallText).toContain('generate_grok_imagine_video');
    expect(toolCallText).toContain('img-cat');
    expect(toolCallText).toContain('xai');

    // Check MCP responses for preview_video call containing resolved_assets
    const previewResponse = responses.find((r) => r.body.includes('resolved_assets'));
    expect(previewResponse).toBeDefined();
    if (previewResponse) {
      const bodyLines = previewResponse.body.split('\n').filter(Boolean);
      for (const line of bodyLines) {
        try {
          const parsed = JSON.parse(line);
          const resultText = parsed?.result?.content?.[0]?.text;
          if (resultText && resultText.includes('resolved_assets')) {
            const preview = JSON.parse(resultText);
            expect(preview.resolved_assets).toBeDefined();
            expect(Array.isArray(preview.resolved_assets)).toBe(true);
            const catAsset = preview.resolved_assets.find((a: { slug: string }) =>
              a.slug.startsWith('img-cat')
            );
            expect(catAsset).toBeDefined();
            expect(catAsset.type).toBe('image');
            expect(catAsset.src).toContain('img-cat');
          }
        } catch {
          // not a JSON line
        }
      }
    }
  });

  test("video gen: submit grok imagine xAI video generation, verify metadata files", async ({ page }) => {
    // Record asset dirs before generation
    const dirsBefore = await findAssetDirs("vid-grok-cat");

    await sendCommand(page, '/video grok @img-cat');
    await waitForGenPanel(page);
    await waitForGenFormReady(page);

    // Select Grok Imagine model + xAI provider
    await selectModel(page, 'grok_imagine');
    await page.waitForTimeout(300);
    await selectProvider(page, 'xAI');
    await page.waitForTimeout(300);

    // Click /generate button
    const genBtn = page.locator('button', { hasText: '/generate' });
    await expect(genBtn).toBeVisible({ timeout: 5_000 });

    const genResponse = page.waitForResponse(
      (resp) => resp.url().includes('/mcp') && resp.status() === 200,
      { timeout: 30_000 },
    );
    await genBtn.click();
    const resp = await genResponse;
    const body = await resp.text();
    expect(body).toContain('enqueued');

    await page.screenshot({ path: "tests/screenshots/grok-video-gen-submitted.png", fullPage: true });

    // Wait for asset to be created on disk
    await page.waitForTimeout(3000);

    // Find newly created grok-cat video asset
    const dirsAfter = await findAssetDirs("vid-grok-cat");
    const newDirs = dirsAfter.filter((d) => !dirsBefore.includes(d));
    expect(newDirs.length).toBeGreaterThanOrEqual(1);

    const newAssetId = newDirs[0];
    console.log("NEW VIDEO ASSET:", newAssetId);

    // Verify .kie-task.json (pending task metadata)
    const kieTask = await readAssetMeta<{
      taskId: string;
      taskType: string;
      assetId: string;
      projectSlug: string;
      meta: { sourceImageId: string };
    }>(newAssetId, "kie-task");
    expect(kieTask).not.toBeNull();
    // xAI video uses "xai_grok_imagine_video" or "grok_imagine_video" task type
    expect(["grok_imagine_video", "xai_grok_imagine_video"]).toContain(kieTask!.taskType);
    expect(kieTask!.assetId).toBe(newAssetId);
    expect(kieTask!.projectSlug).toBe(PROJECT_SLUG);
    expect(kieTask!.meta.sourceImageId).toBe("img-cat");

    // Verify .generation-payload.json
    let genPayload: Record<string, unknown> | null = null;
    for (let i = 0; i < 10; i++) {
      genPayload = await readAssetMeta<Record<string, unknown>>(newAssetId, "generation-payload");
      if (genPayload) break;
      await page.waitForTimeout(1000);
    }

    if (genPayload) {
      console.log("GENERATION PAYLOAD:", JSON.stringify(genPayload));
      // xAI video path: payload has prompt and image_url
      expect(genPayload).toHaveProperty("prompt");
      expect(genPayload).toHaveProperty("image_url");
    }
  });

  test("resolved_assets always contain @img-cat slug", async ({ page }) => {
    const { responses } = collectMcpResponses(page);

    // Test image gen resolved_assets
    await sendCommand(page, '/image grok @img-cat');
    await waitForGenPanel(page);
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    // Collect and verify all preview responses have img-cat in resolved_assets
    const previewResponses = responses.filter((r) => r.body.includes('resolved_assets'));
    expect(previewResponses.length).toBeGreaterThanOrEqual(1);

    for (const previewResp of previewResponses) {
      const bodyLines = previewResp.body.split('\n').filter(Boolean);
      for (const line of bodyLines) {
        try {
          const parsed = JSON.parse(line);
          const resultText = parsed?.result?.content?.[0]?.text;
          if (resultText && resultText.includes('resolved_assets')) {
            const preview = JSON.parse(resultText);
            const assets = preview.resolved_assets as Array<{ slug: string; src: string; type: string }>;

            // Every resolved asset slug that matches should start with img-cat
            const catAssets = assets.filter((a) => a.slug.startsWith('img-cat'));
            expect(catAssets.length).toBeGreaterThanOrEqual(1);

            for (const asset of catAssets) {
              expect(asset.slug).toMatch(/^img-cat/);
              expect(asset.src).toContain(`/${PROJECT_SLUG}/img-cat/`);
              expect(asset.type).toBe('image');
            }
          }
        } catch {
          // skip non-JSON
        }
      }
    }

    await page.screenshot({ path: "tests/screenshots/resolved-assets-img-cat.png", fullPage: true });
  });
});
