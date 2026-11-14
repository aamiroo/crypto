import { test, expect } from '@playwright/test';

test.describe('Crypto Terminal - UI Interactions', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(1500);
  });

  test('switch all chart timeframes', async ({ page }) => {
    const timeframes = [
      '1m', '3m', '5m', '15m', '30m',
      '1h', '4h', '1d', '1w'
    ];

    for (const timeframe of timeframes) {
      const button = page.getByRole('button', {
        name: timeframe,
        exact: true
      });

      await expect(button).toBeVisible();
      await button.click();
      await page.waitForTimeout(500);

      await expect(button).toBeVisible();

      console.log(`TIMEFRAME TESTED: ${timeframe}`);
    }
  });

  test('switch chart display modes', async ({ page }) => {
    const modes = ['Candles', 'Line', 'Area'];

    for (const mode of modes) {
      const button = page.getByRole('button', {
        name: mode,
        exact: true
      });

      await expect(button).toBeVisible();
      await button.click();
      await page.waitForTimeout(500);

      await expect(button).toBeVisible();

      await page.screenshot({
        path: `test-results/chart-${mode.toLowerCase()}.png`
      });

      console.log(`CHART MODE TESTED: ${mode}`);
    }
  });

  test('check for JavaScript errors during interactions', async ({ page }) => {
    const errors: string[] = [];

    page.on('pageerror', error => {
      errors.push(error.message);
    });

    for (const timeframe of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      await page.getByRole('button', {
        name: timeframe,
        exact: true
      }).click();

      await page.waitForTimeout(300);
    }

    await page.getByRole('button', {
      name: 'Line',
      exact: true
    }).click();

    await page.getByRole('button', {
      name: 'Area',
      exact: true
    }).click();

    console.log('JAVASCRIPT ERRORS:', errors);

    expect(errors).toEqual([]);
  });

});
