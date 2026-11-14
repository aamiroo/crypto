import { test, expect } from '@playwright/test';

test.describe('Crypto Terminal - UI Audit', () => {
  test('page loads and renders UI', async ({ page }) => {
    const errors: string[] = [];

    page.on('pageerror', error => errors.push(error.message));

    await page.goto('http://localhost:3000');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    await expect(page.locator('body')).toBeVisible();

    await page.screenshot({
      path: 'test-results/ui-initial.png',
      fullPage: true
    });

    console.log('PAGE TITLE:', await page.title());
    console.log('BUTTONS:', await page.getByRole('button').allTextContents());
    console.log('LINKS:', await page.getByRole('link').allTextContents());
    console.log('INPUTS:', await page.locator('input').count());
    console.log('SELECTS:', await page.locator('select').count());
    console.log('PAGE ERRORS:', errors);
  });

  test('all visible buttons can be inspected', async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForTimeout(2000);

    const buttons = page.getByRole('button');
    const count = await buttons.count();

    console.log(`TOTAL BUTTONS: ${count}`);

    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);

      if (await button.isVisible() && await button.isEnabled()) {
        console.log(`BUTTON ${i + 1}:`, await button.innerText().catch(() => '[no text]'));
      }
    }
  });

  test('layout has no horizontal overflow', async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForTimeout(2000);

    const overflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth
    }));

    console.log('LAYOUT:', overflow);

    expect(overflow.content).toBeLessThanOrEqual(overflow.viewport + 2);
  });
});
