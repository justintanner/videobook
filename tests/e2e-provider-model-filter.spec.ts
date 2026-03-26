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

function getModelOptions(page: Page): Promise<string[]> {
  return page.locator('select[aria-label="/model"] option').evaluateAll(
    (opts) => (opts as HTMLOptionElement[]).map((o) => o.value),
  );
}

function getProviderOptions(page: Page): Promise<string[]> {
  return page.locator('select[aria-label="/provider"] option').evaluateAll(
    (opts) => (opts as HTMLOptionElement[]).map((o) => o.value),
  );
}

test.describe("provider ↔ model filtering", () => {
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

  test("provider dropdown shows both Kie and xAI globally", async ({ page }) => {
    await sendCommand(page, '/image a cat');
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    const providers = await getProviderOptions(page);
    console.log("Provider options:", providers);

    expect(providers).toContain("Kie");
    expect(providers).toContain("xAI");

    await page.screenshot({ path: "tests/screenshots/provider-global-list.png" });
  });

  test("selecting Kie shows all image models", async ({ page }) => {
    await sendCommand(page, '/image a cat');
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    // Select Kie provider
    const providerSelect = page.locator('select[aria-label="/provider"]');
    await providerSelect.selectOption("Kie");
    await page.waitForTimeout(500);

    const models = await getModelOptions(page);
    console.log("Models under Kie:", models);

    // All 4 image models should be available
    expect(models).toContain("nano_banana");
    expect(models).toContain("grok_imagine_image");
    expect(models).toContain("gpt_image");
    expect(models).toContain("grok_imagine_text");

    await page.screenshot({ path: "tests/screenshots/kie-all-models.png" });
  });

  test("selecting xAI filters to only Grok models", async ({ page }) => {
    await sendCommand(page, '/image a cat');
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    // Select xAI provider
    const providerSelect = page.locator('select[aria-label="/provider"]');
    await providerSelect.selectOption("xAI");
    await page.waitForTimeout(500);

    const models = await getModelOptions(page);
    console.log("Models under xAI:", models);

    // Only Grok models should appear
    expect(models).toContain("grok_imagine_image");
    expect(models).toContain("grok_imagine_text");
    expect(models).not.toContain("nano_banana");
    expect(models).not.toContain("gpt_image");

    await page.screenshot({ path: "tests/screenshots/xai-grok-only.png" });
  });

  test("switching to xAI auto-selects a compatible model", async ({ page }) => {
    await sendCommand(page, '/image a cat');
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    // Default should be nano_banana (Kie only)
    const modelSelect = page.locator('select[aria-label="/model"]');
    const initialModel = await modelSelect.inputValue();
    console.log("Initial model:", initialModel);

    // Switch to xAI — nano_banana doesn't support xAI so model should auto-switch
    const providerSelect = page.locator('select[aria-label="/provider"]');
    await providerSelect.selectOption("xAI");
    await page.waitForTimeout(500);

    const newModel = await modelSelect.inputValue();
    console.log("Model after xAI switch:", newModel);

    // Should have switched to a Grok model
    expect(["grok_imagine_image", "grok_imagine_text"]).toContain(newModel);

    await page.screenshot({ path: "tests/screenshots/xai-auto-model-switch.png" });
  });

  test("switching model preserves provider when compatible", async ({ page }) => {
    await sendCommand(page, '/image a cat');
    await waitForGenFormReady(page);
    await page.waitForTimeout(1000);

    // Select xAI provider first
    const providerSelect = page.locator('select[aria-label="/provider"]');
    await providerSelect.selectOption("xAI");
    await page.waitForTimeout(500);

    // Switch between Grok models — provider should stay xAI
    const modelSelect = page.locator('select[aria-label="/model"]');
    await modelSelect.selectOption("grok_imagine_text");
    await page.waitForTimeout(500);

    const provider = await providerSelect.inputValue();
    console.log("Provider after model switch:", provider);
    expect(provider).toBe("xAI");

    await page.screenshot({ path: "tests/screenshots/provider-preserved.png" });
  });
});
