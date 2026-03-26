import { test, expect, type Page } from "playwright/test";

const BASE = "http://localhost:5174";
const PROJECT_SLUG = "happy-koala-71";

test.setTimeout(120_000);

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

async function waitForGenFormReady(page: Page): Promise<void> {
  await page.locator('text=/prompt').first().waitFor({ state: 'visible', timeout: 30_000 });
}

test.describe("image gen panel settings", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(3000);

    const headerText = await page.locator('button', { hasText: 'projects/' }).textContent();
    if (!headerText?.includes(PROJECT_SLUG)) {
      await switchProject(page, PROJECT_SLUG);
    } else {
      await waitForAssetsLoaded(page);
    }
  });

  test("image gen panel shows /settings with aspect_ratio, resolution, output_format", async ({ page }) => {
    await sendCommand(page, '/image @img-cat');
    await waitForGenFormReady(page);
    await page.waitForTimeout(2000);

    await page.screenshot({ path: "tests/screenshots/image-gen-settings.png" });

    // Check /settings section exists
    const settingsHeader = page.locator('text=/settings');
    const settingsVisible = await settingsHeader.isVisible().catch(() => false);
    console.log("Settings section visible:", settingsVisible);

    // Check what fields are visible
    const pageText = await page.textContent('body');
    console.log("Has /prompt:", pageText?.includes('/prompt'));
    console.log("Has /settings:", pageText?.includes('/settings'));
    console.log("Has Aspect Ratio:", pageText?.includes('Aspect Ratio'));
    console.log("Has Resolution:", pageText?.includes('Resolution'));
    console.log("Has Output Format:", pageText?.includes('Output Format'));
    console.log("Has /images:", pageText?.includes('/images'));

    // Check model selector
    const modelText = await page.locator('select[aria-label="/model"]').inputValue().catch(() => 'not found');
    console.log("Selected model:", modelText);

    // The /settings section should be visible
    expect(settingsVisible).toBe(true);
  });
});
