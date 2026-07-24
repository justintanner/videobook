import { test, expect, type Page } from "playwright/test";

const BASE = "http://localhost:5174";
const BOOK_ID = "happy-koala-71";

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

async function waitForGenFormReady(page: Page): Promise<void> {
  await page.locator('text=/prompt').first().waitFor({ state: 'visible', timeout: 30_000 });
}

// ── Tests ────────────────────────────────────────────────────────────

test.describe("gen panel scroll", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(3000);

    const headerText = await page.locator('button', { hasText: 'projects/' }).textContent();
    if (!headerText?.includes(BOOK_ID)) {
      await switchProject(page, BOOK_ID);
    } else {
      await waitForAssetsLoaded(page);
    }
  });

  test("gen panel form content scrolls when overflowing", async ({ page }) => {
    // Open the video gen panel
    await sendCommand(page, '/video make a test video @img-cat');
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    // Take a screenshot before scroll attempt
    await page.screenshot({ path: "tests/screenshots/gen-scroll-before.png" });

    // Find the scroll container — the overflow-y-auto div inside the gen panel
    const scrollContainer = page.locator('[class*="overflow-y-auto"][class*="inset-0"]').first();
    await expect(scrollContainer).toBeVisible();

    // Get scroll metrics at default viewport
    const scrollInfo = await scrollContainer.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
      overflowY: getComputedStyle(el).overflowY,
      canScroll: el.scrollHeight > el.clientHeight,
    }));
    console.log("Scroll info (default viewport):", JSON.stringify(scrollInfo, null, 2));

    // Shrink viewport to guarantee overflow
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.waitForTimeout(500);

    const scrollInfoSmall = await scrollContainer.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
      overflowY: getComputedStyle(el).overflowY,
      canScroll: el.scrollHeight > el.clientHeight,
    }));
    console.log("Scroll info (500px viewport):", JSON.stringify(scrollInfoSmall, null, 2));

    await page.screenshot({ path: "tests/screenshots/gen-scroll-small-viewport.png" });

    // Try scrolling with mouse wheel
    await scrollContainer.hover();
    const scrollTopBefore = await scrollContainer.evaluate((el) => el.scrollTop);

    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(500);

    const scrollTopAfterWheel = await scrollContainer.evaluate((el) => el.scrollTop);
    console.log(`Wheel scroll: before=${scrollTopBefore}, after=${scrollTopAfterWheel}`);

    await page.screenshot({ path: "tests/screenshots/gen-scroll-after-wheel.png" });

    // Also try programmatic scroll to diagnose CSS vs event issue
    const programmaticScroll = await scrollContainer.evaluate((el) => {
      el.scrollTop = 0; // reset
      const before = el.scrollTop;
      el.scrollTop = 150;
      const after = el.scrollTop;
      return { before, after, changed: before !== after };
    });
    console.log("Programmatic scroll:", JSON.stringify(programmaticScroll, null, 2));

    // At least one method must work
    const wheelWorked = scrollTopAfterWheel > scrollTopBefore;
    const programmaticWorked = programmaticScroll.changed;

    console.log(`Results: wheelWorked=${wheelWorked}, programmaticWorked=${programmaticWorked}`);

    expect(wheelWorked || programmaticWorked).toBe(true);
  });
});
