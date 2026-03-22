import { test, expect, type Page } from "playwright/test";

const BASE = "http://localhost:5174";

test.setTimeout(120_000);

const CYAN_BG = 'rgb(0, 217, 255)';

// ── Helpers ──────────────────────────────────────────────────────────

async function waitForAssetsLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const els = document.querySelectorAll("*");
    for (const el of els) {
      if (el.textContent?.includes("@vid-")) return true;
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

/** Click the first video clip card in the right sidebar */
async function selectFirstClip(page: Page): Promise<void> {
  // Right sidebar contains video/final cards — click the first one with a @vid- reference
  const clipCard = page.locator('text=@vid-').first();
  await clipCard.click({ timeout: 10_000 });
  await page.waitForTimeout(500);
}

/** Open the settings panel by clicking the gear icon on the asset viewer */
async function openSettingsPanel(page: Page): Promise<void> {
  const settingsBtn = page.locator('button[title="/settings"]');
  await settingsBtn.click({ timeout: 5_000 });
  await page.waitForTimeout(300);
  // Verify the settings panel is visible (back face with /settings tab)
  await expect(page.locator('text=/settings').first()).toBeVisible({ timeout: 5_000 });
}

/** Type a slash command in the chat input and submit */
async function sendCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="input-chat"]');
  await input.fill(command);
  await page.waitForTimeout(200);
  await input.press('Enter');
  await page.waitForTimeout(500);
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("render and download with non-default options", () => {
  test.beforeEach(async ({ page }) => {
    page.on("console", (msg) => {
      if (msg.text().includes("[sync]") || msg.text().includes("error") || msg.text().includes("[render]")) {
        console.log(`BROWSER: ${msg.text()}`);
      }
    });

    await page.goto(BASE);
    await page.waitForTimeout(3000);

    // Switch to noble-salmon-30 which has video assets
    const headerText = await page.locator('button', { hasText: 'projects/' }).textContent();
    if (!headerText?.includes("noble-salmon-30")) {
      await switchProject(page, "noble-salmon-30");
    } else {
      await waitForAssetsLoaded(page);
    }
  });

  test("settings panel: change subtitle style to highlight and position to top", async ({ page }) => {
    await selectFirstClip(page);
    await openSettingsPanel(page);
    await page.screenshot({ path: "tests/screenshots/render-settings-default.png", fullPage: true });

    // Click 'Highlight' in the segmented control (subtitle style)
    const highlightBtn = page.locator('button', { hasText: 'Highlight' });
    await highlightBtn.click();
    await page.waitForTimeout(200);

    // Click 'Top' for subtitle position
    const topBtn = page.locator('button', { hasText: 'Top' }).first();
    await topBtn.click();
    await page.waitForTimeout(200);

    await page.screenshot({ path: "tests/screenshots/render-settings-highlight-top.png", fullPage: true });

    // Verify the highlight button has the active style (cyan background)
    const highlightStyle = await highlightBtn.evaluate(el => el.style.background);
    expect(highlightStyle).toContain(CYAN_BG);

    // Verify Top button has active style
    const topStyle = await topBtn.evaluate(el => el.style.background);
    expect(topStyle).toContain(CYAN_BG);
  });

  test("settings panel: set background to black mode", async ({ page }) => {
    await selectFirstClip(page);
    await openSettingsPanel(page);

    // Click 'Black' background mode button
    const blackBtn = page.locator('button', { hasText: 'Black' });
    await blackBtn.click();
    await page.waitForTimeout(200);

    await page.screenshot({ path: "tests/screenshots/render-settings-bg-black.png", fullPage: true });

    // Verify Black is active
    const blackStyle = await blackBtn.evaluate(el => el.style.background);
    expect(blackStyle).toContain(CYAN_BG);

    // Verify Blur is NOT active
    const blurBtn = page.locator('button', { hasText: 'Blur' });
    const blurStyle = await blurBtn.evaluate(el => el.style.background);
    expect(blurStyle).not.toContain(CYAN_BG);
  });

  test("settings panel: set font size to large and disable subtitles", async ({ page }) => {
    await selectFirstClip(page);
    await openSettingsPanel(page);

    // Click 'L' for large font size
    const largeBtn = page.locator('button', { hasText: 'L' }).first();
    await largeBtn.click();
    await page.waitForTimeout(200);

    // Click 'OFF' to disable subtitles
    const offBtn = page.locator('button', { hasText: 'OFF' });
    await offBtn.click();
    await page.waitForTimeout(200);

    await page.screenshot({ path: "tests/screenshots/render-settings-large-nosubs.png", fullPage: true });

    // OFF should be active
    const offStyle = await offBtn.evaluate(el => el.style.background);
    expect(offStyle).toContain(CYAN_BG);
  });

  test("settings panel: change audio volume via minus button", async ({ page }) => {
    await selectFirstClip(page);
    await openSettingsPanel(page);

    // The /audio section has Volume with a NumberInput showing 100
    // Find the "100" value display and its adjacent minus button
    const volumeValue = page.locator('text=100').first();
    await expect(volumeValue).toBeVisible({ timeout: 5_000 });

    // Click the minus button next to the volume display (decrements by 5)
    // The NumberInput has minus button -> value display -> plus button
    // Find the /audio section and click the first minus button in it
    const audioSection = page.locator('text=/audio').locator('..').locator('..');
    const minusButtons = audioSection.locator('button').filter({ has: page.locator('svg') });

    // Click minus button 4 times to go from 100 to 80
    for (let i = 0; i < 4; i++) {
      await minusButtons.first().click();
      await page.waitForTimeout(100);
    }

    await page.screenshot({ path: "tests/screenshots/render-settings-volume-80.png", fullPage: true });

    // Verify volume changed (should show 80 now)
    await expect(page.locator('text=80').first()).toBeVisible({ timeout: 3_000 });
  });

  test("settings panel: change OSG position to bottom-left", async ({ page }) => {
    await selectFirstClip(page);
    await openSettingsPanel(page);

    // Click 'BL' in the toggle grid for OSG position (exact match to avoid Blur/Black)
    const blBtn = page.getByRole('button', { name: 'BL', exact: true });
    await blBtn.click();
    await page.waitForTimeout(200);

    await page.screenshot({ path: "tests/screenshots/render-settings-osg-bl.png", fullPage: true });

    // BL should be active
    const blStyle = await blBtn.evaluate(el => el.style.background);
    expect(blStyle).toContain(CYAN_BG);

    // TR should not be active (was the default)
    const trBtn = page.getByRole('button', { name: 'TR', exact: true });
    const trStyle = await trBtn.evaluate(el => el.style.background);
    expect(trStyle).not.toContain(CYAN_BG);
  });

  test("settings panel: click render button enqueues render", async ({ page }) => {
    await selectFirstClip(page);
    await openSettingsPanel(page);

    // Change some settings first (black bg, subs off) to use non-default
    const blackBtn = page.locator('button', { hasText: 'Black' });
    await blackBtn.click();
    await page.waitForTimeout(200);

    const offBtn = page.locator('button', { hasText: 'OFF' });
    await offBtn.click();
    await page.waitForTimeout(200);

    // Click the /render button and verify the MCP render tool was called
    const renderBtn = page.locator('button', { hasText: '/render' });
    await expect(renderBtn).toBeVisible({ timeout: 5_000 });

    // Wait for MCP response containing "enqueued" (render tool success)
    const renderResponse = page.waitForResponse(
      (resp) => resp.url().includes('/mcp') && resp.status() === 200,
      { timeout: 30_000 },
    );
    await renderBtn.click();
    const resp = await renderResponse;
    const body = await resp.text();
    expect(body).toContain('enqueued');

    await page.screenshot({ path: "tests/screenshots/render-submitted.png", fullPage: true });
  });

  test("slash command /subs off dispatches to settings panel", async ({ page }) => {
    await selectFirstClip(page);
    await sendCommand(page, '/subs off');

    // Settings panel should be visible (viewer flips to back)
    await page.waitForTimeout(1000);
    await page.screenshot({ path: "tests/screenshots/slash-subs-off.png", fullPage: true });

    // The OFF button should be active
    const offBtn = page.locator('button', { hasText: 'OFF' });
    await expect(offBtn).toBeVisible({ timeout: 5_000 });
    const offStyle = await offBtn.evaluate(el => el.style.background);
    expect(offStyle).toContain(CYAN_BG);
  });

  test("slash command /bg black switches background mode", async ({ page }) => {
    await selectFirstClip(page);
    await sendCommand(page, '/bg black');

    await page.waitForTimeout(1000);
    await page.screenshot({ path: "tests/screenshots/slash-bg-black.png", fullPage: true });

    // Black button should be active
    const blackBtn = page.locator('button', { hasText: 'Black' });
    await expect(blackBtn).toBeVisible({ timeout: 5_000 });
    const blackStyle = await blackBtn.evaluate(el => el.style.background);
    expect(blackStyle).toContain(CYAN_BG);
  });

  test("slash command /audio volume 50 adjusts volume", async ({ page }) => {
    await selectFirstClip(page);
    await sendCommand(page, '/audio volume 50');

    await page.waitForTimeout(1000);
    await page.screenshot({ path: "tests/screenshots/slash-audio-vol-50.png", fullPage: true });

    // Volume should show 50
    await expect(page.locator('text=50').first()).toBeVisible({ timeout: 5_000 });
  });

  test("slash command /subs style highlight changes subtitle style", async ({ page }) => {
    await selectFirstClip(page);
    await sendCommand(page, '/subs style highlight');

    await page.waitForTimeout(1000);
    await page.screenshot({ path: "tests/screenshots/slash-subs-highlight.png", fullPage: true });

    // Highlight should be active in the segmented control
    const highlightBtn = page.locator('button', { hasText: 'Highlight' });
    await expect(highlightBtn).toBeVisible({ timeout: 5_000 });
    const highlightStyle = await highlightBtn.evaluate(el => el.style.background);
    expect(highlightStyle).toContain(CYAN_BG);
  });

  test("slash command /subs position top sets subtitle position", async ({ page }) => {
    await selectFirstClip(page);
    await sendCommand(page, '/subs position top');

    await page.waitForTimeout(1000);

    // Top button should be active
    const topBtn = page.locator('button', { hasText: 'Top' }).first();
    await expect(topBtn).toBeVisible({ timeout: 5_000 });
    const topStyle = await topBtn.evaluate(el => el.style.background);
    expect(topStyle).toContain(CYAN_BG);
  });

  test("slash command /osg position bl sets OSG position", async ({ page }) => {
    await selectFirstClip(page);
    await sendCommand(page, '/osg position bl');

    await page.waitForTimeout(1000);
    await page.screenshot({ path: "tests/screenshots/slash-osg-bl.png", fullPage: true });

    // BL should be active (exact match to avoid Blur/Black)
    const blBtn = page.getByRole('button', { name: 'BL', exact: true });
    await expect(blBtn).toBeVisible({ timeout: 5_000 });
    const blStyle = await blBtn.evaluate(el => el.style.background);
    expect(blStyle).toContain(CYAN_BG);
  });

  test("settings panel: switch orientation tabs", async ({ page }) => {
    await selectFirstClip(page);
    await openSettingsPanel(page);

    // Click + PORTRAIT orientation tab
    const portraitTab = page.locator('button', { hasText: '+ PORTRAIT' });
    if (await portraitTab.isVisible()) {
      await portraitTab.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: "tests/screenshots/render-orient-portrait.png", fullPage: true });
    }

    // Click + SQUARE orientation tab
    const squareTab = page.locator('button', { hasText: '+ SQUARE' });
    if (await squareTab.isVisible()) {
      await squareTab.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: "tests/screenshots/render-orient-square.png", fullPage: true });
    }
  });

  test("settings panel: multiple non-default options combined then render", async ({ page }) => {
    await selectFirstClip(page);
    await openSettingsPanel(page);

    // 1. Subtitles → OFF (asset may lack elevenlabs.json)
    await page.locator('button', { hasText: 'OFF' }).click();
    await page.waitForTimeout(150);

    // 2. Subtitle style → highlight (for when subs are re-enabled)
    await page.locator('button', { hasText: 'Highlight' }).click();
    await page.waitForTimeout(150);

    // 3. Position → top
    await page.locator('button', { hasText: 'Top' }).first().click();
    await page.waitForTimeout(150);

    // 4. Font size → large
    await page.locator('button', { hasText: 'L' }).first().click();
    await page.waitForTimeout(150);

    // 5. Background → black
    await page.locator('button', { hasText: 'Black' }).click();
    await page.waitForTimeout(150);

    // 6. OSG position → bottom-left (exact match to avoid Blur/Black)
    await page.getByRole('button', { name: 'BL', exact: true }).click();
    await page.waitForTimeout(150);

    await page.screenshot({ path: "tests/screenshots/render-combined-settings.png", fullPage: true });

    // Verify selections are active (cyan bg)
    for (const label of ['OFF', 'Highlight', 'Black']) {
      const btn = page.locator('button', { hasText: label }).first();
      const bg = await btn.evaluate(el => el.style.background);
      expect(bg).toContain(CYAN_BG);
    }
    const blBg = await page.getByRole('button', { name: 'BL', exact: true }).evaluate(el => el.style.background);
    expect(blBg).toContain(CYAN_BG);

    // Click render and verify MCP render tool was called
    const renderBtn = page.locator('button', { hasText: '/render' });
    const renderResponse = page.waitForResponse(
      (resp) => resp.url().includes('/mcp') && resp.status() === 200,
      { timeout: 30_000 },
    );
    await renderBtn.click();
    const resp = await renderResponse;
    const body = await resp.text();
    expect(body).toContain('enqueued');

    await page.screenshot({ path: "tests/screenshots/render-combined-submitted.png", fullPage: true });
  });

  test("download: /subs and /audio commands chain before render", async ({ page }) => {
    await selectFirstClip(page);

    // Send multiple setting commands in sequence
    await sendCommand(page, '/subs off');
    await page.waitForTimeout(500);

    // Flip back to front to re-enter commands
    const flipBackBtn = page.locator('svg.lucide-rotate-ccw').first();
    if (await flipBackBtn.isVisible()) {
      await flipBackBtn.click();
      await page.waitForTimeout(300);
    }

    await sendCommand(page, '/audio volume 25');
    await page.waitForTimeout(500);

    await page.screenshot({ path: "tests/screenshots/chained-commands.png", fullPage: true });

    // Verify both settings took effect
    const offBtn = page.locator('button', { hasText: 'OFF' });
    await expect(offBtn).toBeVisible({ timeout: 5_000 });
    const offStyle = await offBtn.evaluate(el => el.style.background);
    expect(offStyle).toContain(CYAN_BG);

    // Volume should show 25
    await expect(page.locator('text=25').first()).toBeVisible({ timeout: 3_000 });
  });

  test("settings panel: files tab accessible from back face", async ({ page }) => {
    await selectFirstClip(page);
    await openSettingsPanel(page);

    // Click /files tab
    const filesTab = page.locator('button', { hasText: '/files' });
    await filesTab.click();
    await page.waitForTimeout(1000);

    await page.screenshot({ path: "tests/screenshots/files-tab.png", fullPage: true });

    // Should show file list (e.g. .original.json or original.mp4)
    const hasFileContent = await page.locator('text=original').first().isVisible().catch(() => false);
    expect(hasFileContent).toBe(true);
  });
});
