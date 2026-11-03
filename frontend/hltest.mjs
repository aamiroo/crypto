import { chromium } from 'playwright-core';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('console', m => errors.push('[' + m.type() + '] ' + m.text()));
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', r => errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(5000);
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
const html = await page.content();
await browser.close();
console.log('=== BODY ===\n' + bodyText);
console.log('=== ERRORS ===\n' + errors.join('\n'));
console.log('=== HAS TopBar/MarketHeader/ChartPanel ===\n' + (html.includes('MarketHeader') ? 'YES' : 'NO'));
process.exit(0);