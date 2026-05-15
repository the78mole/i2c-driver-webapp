/**
 * screenshot.mjs – Takes a styled screenshot of the built app.
 *
 * Usage:
 *   node screenshot.mjs [output.png]
 *
 * Expects the Vite preview server to already be running at
 * http://localhost:4173/i2c-driver-webapp/ (started with BASE_PATH set).
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';

const outFile = process.argv[2] ?? 'app-screenshot.png';

const browser = await chromium.launch({
  args: [
    '--disable-gpu',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

// Navigate and wait until no more network activity (CSS/JS fully loaded)
await page.goto('http://localhost:4173/i2c-driver-webapp/', {
  waitUntil: 'networkidle',
  timeout: 30_000,
});

// Extra settle time for xterm.js canvas rendering and CSS transitions
await page.waitForTimeout(2000);

// ── CSS diagnostic ────────────────────────────────────────────────────────────
const bodyBg   = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const cardBg   = await page.evaluate(() => {
  const el = document.querySelector('.card');
  return el ? getComputedStyle(el).backgroundColor : '(no .card)';
});
const btnColor = await page.evaluate(() => {
  const el = document.querySelector('.btn-primary');
  return el ? getComputedStyle(el).backgroundColor : '(no .btn-primary)';
});
const cssFiles = await page.evaluate(() =>
  [...document.styleSheets].map(s => s.href ?? 'inline').join(', ')
);

console.log('── CSS diagnostic ───────────────────────────────');
console.log('body background  :', bodyBg);
console.log('.card background :', cardBg);
console.log('.btn-primary bg  :', btnColor);
console.log('stylesheets      :', cssFiles);
console.log('────────────────────────────────────────────────');

// ── Screenshot ────────────────────────────────────────────────────────────────
await page.screenshot({ path: outFile, fullPage: false });
console.log('Screenshot saved to', outFile);

await browser.close();
