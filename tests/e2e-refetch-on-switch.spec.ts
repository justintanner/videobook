import { test, expect, type Page } from "playwright/test";

const BASE = "http://localhost:5174";
const BOOK_ID = "dancing-banana-62";

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

test.describe("refetch on model/provider switch", () => {
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

  test("switching model refetches and rebuilds settings", async ({ page }) => {
    await sendCommand(page, '/image a beautiful landscape');
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    // Capture initial settings section text
    const initialSettings = await page.locator('text=/settings').first().locator('..').locator('..').textContent();
    console.log("Initial settings:", initialSettings?.substring(0, 200));

    // Get initial model
    const modelSelect = page.locator('select[aria-label="/model"]');
    const initialModel = await modelSelect.inputValue();
    console.log("Initial model:", initialModel);

    // Switch to grok_imagine_text (text-to-image, no image slots)
    await modelSelect.selectOption("grok_imagine_text");

    // Wait for refetch to complete — form should rebuild
    await page.waitForTimeout(3000);

    const newModel = await modelSelect.inputValue();
    console.log("Model after switch:", newModel);
    expect(newModel).toBe("grok_imagine_text");

    // Settings section should have changed (Grok Imagine has different params)
    const newSettings = await page.locator('text=/settings').first().locator('..').locator('..').textContent();
    console.log("New settings:", newSettings?.substring(0, 200));

    await page.screenshot({ path: "tests/screenshots/refetch-model-switch.png" });
  });

  test("switching provider refetches and auto-selects compatible model", async ({ page }) => {
    await sendCommand(page, '/image a cat');
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    // Default should be nano_banana under Kie
    const modelSelect = page.locator('select[aria-label="/model"]');
    const providerSelect = page.locator('select[aria-label="/provider"]');

    const initialModel = await modelSelect.inputValue();
    const initialProvider = await providerSelect.inputValue();
    console.log("Initial:", initialModel, initialProvider);

    // Switch to xAI — nano_banana doesn't support xAI, should auto-switch model
    await providerSelect.selectOption("xAI");

    // Wait for refetch to complete
    await page.waitForTimeout(3000);

    const newModel = await modelSelect.inputValue();
    const newProvider = await providerSelect.inputValue();
    console.log("After xAI switch:", newModel, newProvider);

    expect(newProvider).toBe("xAI");
    // nano_banana doesn't support xAI, so model should have changed
    expect(["grok_imagine_image", "grok_imagine_text"]).toContain(newModel);

    await page.screenshot({ path: "tests/screenshots/refetch-provider-switch.png" });
  });

  test("prompt text is preserved across model switch", async ({ page }) => {
    const testPrompt = "a unique test prompt for refetch verification";
    await sendCommand(page, `/image ${testPrompt}`);
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    // Verify prompt is in the textarea
    const promptTextarea = page.locator('textarea').first();
    const initialPromptValue = await promptTextarea.inputValue();
    console.log("Initial prompt:", initialPromptValue);
    expect(initialPromptValue).toContain("unique test prompt");

    // Edit the prompt
    await promptTextarea.fill("edited prompt content 12345");
    await page.waitForTimeout(200);

    // Switch model
    const modelSelect = page.locator('select[aria-label="/model"]');
    await modelSelect.selectOption("grok_imagine_text");

    // Wait for refetch
    await page.waitForTimeout(3000);

    // Prompt should be preserved (the edited version, not original)
    const preservedPrompt = await promptTextarea.inputValue();
    console.log("Prompt after switch:", preservedPrompt);
    expect(preservedPrompt).toBe("edited prompt content 12345");

    await page.screenshot({ path: "tests/screenshots/refetch-prompt-preserved.png" });
  });

  test("switching provider then model keeps provider consistent", async ({ page }) => {
    await sendCommand(page, '/image a dog');
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    const modelSelect = page.locator('select[aria-label="/model"]');
    const providerSelect = page.locator('select[aria-label="/provider"]');

    // Switch to xAI
    await providerSelect.selectOption("xAI");
    await page.waitForTimeout(3000);

    // Now switch between xAI-compatible models
    await modelSelect.selectOption("grok_imagine_text");
    await page.waitForTimeout(3000);

    // Provider should still be xAI
    const provider = await providerSelect.inputValue();
    console.log("Provider after model switch:", provider);
    expect(provider).toBe("xAI");

    // Switch to grok_imagine_image (also supports xAI)
    await modelSelect.selectOption("grok_imagine_image");
    await page.waitForTimeout(3000);

    const provider2 = await providerSelect.inputValue();
    console.log("Provider after second model switch:", provider2);
    expect(provider2).toBe("xAI");

    await page.screenshot({ path: "tests/screenshots/refetch-provider-consistent.png" });
  });
});
