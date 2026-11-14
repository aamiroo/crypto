
import { test, expect } from "@playwright/test";

test.describe("Crypto Terminal UI Controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:3000");
    await expect(page.locator("body")).toBeVisible();
  });

  test("Symbol Picker: search and select a symbol", async ({ page }) => {
    const search = page.getByRole("textbox", { name: "Search symbol" });

    await search.click();

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();

    const options = listbox.getByRole("option");
    await expect(options.first()).toBeVisible();

    const currentPlaceholder = await search.getAttribute("placeholder");

    // Select a symbol different from the currently selected one.
    const optionTexts = await options.allTextContents();
    const targetIndex = optionTexts.findIndex(
      (text) => !text.includes(currentPlaceholder?.replace("/", "") ?? "")
    );

    if (targetIndex >= 0) {
      const target = options.nth(targetIndex);
      const targetText = (await target.innerText()).trim();
      const targetSymbol = targetText.split(/\s+/)[0];

      await target.click();

      await expect(listbox).toBeHidden();
      await expect(search).toHaveAttribute(
        "placeholder",
        new RegExp(targetSymbol.split("/")[0])
      );
    } else {
      await search.fill("THIS_SYMBOL_DOES_NOT_EXIST");
      await expect(page.getByText(/No symbols match/i)).toBeVisible();
    }
  });

  test("Symbol Picker: keyboard navigation and Escape", async ({ page }) => {
    const search = page.getByRole("textbox", { name: "Search symbol" });

    await search.focus();
    await search.press("ArrowDown");

    await expect(page.getByRole("listbox")).toBeVisible();

    await search.press("Escape");

    await expect(page.getByRole("listbox")).toBeHidden();
  });

  test("Watchlist: switch tabs and filter symbols", async ({ page }) => {
    await page.getByRole("button", { name: "All", exact: true }).click();

    const filter = page.getByRole("textbox", {
      name: "Filter watchlist",
    });

    await filter.fill("BTC");

    const btcButton = page.getByRole("button", {
      name: "BTC",
      exact: true,
    });

    await expect(btcButton).toBeVisible();

    await filter.fill("THIS_SYMBOL_DOES_NOT_EXIST");

    await expect(
      page.getByText("No symbols", { exact: true })
    ).toBeVisible();

    await filter.clear();
  });

  test("Watchlist: favorite can be added and removed", async ({ page }) => {
    await page.getByRole("button", { name: "All", exact: true }).click();

    const filter = page.getByRole("textbox", {
      name: "Filter watchlist",
    });

    await filter.fill("BTC");

    const addFavorite = page.getByRole("button", {
      name: "Add BTCUSDT to favorites",
    });

    await expect(addFavorite).toBeVisible();
    await addFavorite.click();

    const removeFavorite = page.getByRole("button", {
      name: "Remove BTCUSDT from favorites",
    });

    await expect(removeFavorite).toBeVisible();

    // Restore the original state.
    await removeFavorite.click();

    await expect(
      page.getByRole("button", {
        name: "Add BTCUSDT to favorites",
      })
    ).toBeVisible();
  });

  test("Watchlist: sorting controls are interactive", async ({ page }) => {
    await page.getByRole("button", { name: "All", exact: true }).click();

    await page.getByRole("button", { name: "Price", exact: true }).click();
    await page.getByRole("button", { name: "24h", exact: true }).click();
    await page.getByRole("button", { name: "Vol", exact: true }).click();
    await page.getByRole("button", { name: "Symbol", exact: true }).click();

    await expect(
      page.getByRole("textbox", { name: "Filter watchlist" })
    ).toBeVisible();
  });

  test("Indicators: add, configure, hide and remove SMA", async ({ page }) => {
    // The Popover trigger exposes its tooltip as a title.
    await page.getByTitle("Indicators").click();

    const addSma = page.getByRole("button", { name: "+ SMA" });
    await expect(addSma).toBeVisible();
    await addSma.click();

    const smaRow = page.locator("div").filter({
      has: page.getByText("SMA", { exact: true }),
    }).filter({
      has: page.getByRole("button", { name: "Remove SMA" }),
    }).last();

    await expect(page.getByRole("button", { name: "Remove SMA" })).toBeVisible();

    const period = page.getByTitle("Period").first();
    await expect(period).toHaveValue("20");

    await period.fill("30");
    await expect(period).toHaveValue("30");

    const visibility = page.locator('input[type="checkbox"]').nth(1);
    await visibility.click();
    await expect(visibility).not.toBeChecked();

    await visibility.click();
    await expect(visibility).toBeChecked();

    await page.getByRole("button", { name: "Remove SMA" }).click();
    await expect(page.getByRole("button", { name: "Remove SMA" })).toHaveCount(0);
  });

  test("Drawings Panel: open and close", async ({ page }) => {
    const openButton = page.getByRole("button", {
      name: "Open drawings list",
    });

    await openButton.click();

    const panel = page.locator("[data-draw-ui]");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Drawings");

    await panel.getByRole("button", {
      name: "Close drawings list",
    }).click();

    await expect(panel).toBeHidden();
  });

  test("Chart Toolbar: chart type selection updates active state", async ({ page }) => {
    const candles = page.getByRole("button", { name: "Candles", exact: true });
    const line = page.getByRole("button", { name: "Line", exact: true });
    const area = page.getByRole("button", { name: "Area", exact: true });

    await line.click();
    await expect(line).toHaveAttribute("data-active", "true");

    await area.click();
    await expect(area).toHaveAttribute("data-active", "true");

    await candles.click();
    await expect(candles).toHaveAttribute("data-active", "true");
  });

  test("Chart Toolbar: drawing controls have correct initial state", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: "Undo drawing" })
    ).toBeDisabled();

    await expect(
      page.getByRole("button", { name: "Redo drawing" })
    ).toBeDisabled();

    await expect(
      page.getByRole("button", { name: "Delete all drawings" })
    ).toBeDisabled();

    await expect(
      page.getByRole("button", { name: "Toggle drawings visibility" })
    ).toBeVisible();
  });

  test("No uncaught JavaScript errors during control interactions", async ({ page }) => {
    const errors: string[] = [];

    page.on("pageerror", (error) => {
      errors.push(error.message);
    });

    await page.getByRole("button", { name: "Line", exact: true }).click();
    await page.getByRole("button", { name: "Area", exact: true }).click();
    await page.getByRole("button", { name: "Candles", exact: true }).click();

    await page.getByRole("button", { name: "Open drawings list" }).click();
    await page.getByRole("button", { name: "Close drawings list" }).click();

    expect(errors).toEqual([]);
  });
});

