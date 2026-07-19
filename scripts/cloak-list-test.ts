/**
 * CloakBrowser driver for exercising the sidebar asset/clip lists.
 * Usage: npx tsx scripts/cloak-list-test.ts <outDir>
 * Takes screenshots into <outDir> and prints console/page errors as JSON.
 */
import { launch } from 'cloakbrowser';
import type { Page } from 'playwright-core';

const outDir = process.argv[2] ?? '.';
const APP_URL = 'http://localhost:5173/';

interface CapturedMessage {
  kind: 'console-error' | 'console-warning' | 'pageerror' | 'requestfailed';
  step: string;
  text: string;
}

let currentStep = 'startup';
const captured: CapturedMessage[] = [];

function wirePage(page: Page): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') captured.push({ kind: 'console-error', step: currentStep, text: msg.text() });
    if (msg.type() === 'warning') captured.push({ kind: 'console-warning', step: currentStep, text: msg.text() });
  });
  page.on('pageerror', (err) => captured.push({ kind: 'pageerror', step: currentStep, text: String(err) }));
  page.on('requestfailed', (req) => {
    captured.push({ kind: 'requestfailed', step: currentStep, text: `${req.method()} ${req.url()} — ${req.failure()?.errorText}` });
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`[shot] ${name}`);
}

function step(name: string): void {
  currentStep = name;
  console.log(`[step] ${name}`);
}

const browser = await launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
wirePage(page);

await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await shot(page, '01-initial');

const leftList = page.locator('aside').first();
const rightList = page.locator('aside').last();
const leftCards = leftList.locator('.aspect-video');
const rightCards = rightList.locator('.aspect-video');

step('scroll-asset-list-bottom');
await leftList.evaluate((aside) => {
  const scroller = Array.from(aside.querySelectorAll('*')).find(
    (el) => el.scrollHeight > el.clientHeight + 10 && getComputedStyle(el).overflowY !== 'visible',
  );
  scroller?.scrollTo({ top: scroller.scrollHeight });
});
await page.waitForTimeout(600);
await shot(page, '02-assets-scrolled-bottom');

step('sort-toggle');
const firstLabelBefore = await leftCards.first().textContent();
await leftList.locator('button').first().click();
await page.waitForTimeout(600);
const firstLabelAfter = await leftCards.first().textContent();
console.log('[sort] first card before:', JSON.stringify(firstLabelBefore));
console.log('[sort] first card after :', JSON.stringify(firstLabelAfter));
await shot(page, '03-assets-sorted-oldest');
await leftList.locator('button').first().click();
await page.waitForTimeout(400);

step('click-asset-card');
await leftCards.nth(1).click();
await page.waitForTimeout(1500);
await shot(page, '04-asset-viewer-open');

step('click-clip-card');
await rightCards.first().click();
await page.waitForTimeout(1500);
await shot(page, '05-clip-viewer-open');

step('context-menu');
await leftCards.nth(1).click({ button: 'right' });
await page.waitForTimeout(600);
await shot(page, '06-context-menu');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

step('collapse-left-sidebar');
await leftList.locator('button').nth(1).click();
await page.waitForTimeout(600);
await shot(page, '07-left-collapsed');
await leftList.click();
await page.waitForTimeout(600);
await shot(page, '08-left-expanded-again');

step('counts');
console.log('[counts] left cards:', await leftCards.count(), 'right cards:', await rightCards.count());

console.log('[errors]', JSON.stringify(captured, null, 2));
await browser.close();
