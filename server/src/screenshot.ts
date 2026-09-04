type ScreenshotOptions = {
  url: string;
  width?: number;
  height?: number;
};

export async function takeScreenshot({
  url,
  width = 1920,
  height = 1080,
}: ScreenshotOptions): Promise<Buffer> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url, { waitUntil: "networkidle" });
    const buffer = await page.screenshot({ type: "png", fullPage: false });
    return Buffer.from(buffer);
  } finally {
    await browser.close();
  }
}
