import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("page shell", () => {
  test("shows the disclaimer with the emergency numbers", async ({ page }) => {
    await page.goto("/");
    const warning = page.getByRole("complementary", { name: "Avertissement" });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("pas un outil opérationnel ni une source officielle");
    await expect(warning.getByRole("link", { name: "18" })).toHaveAttribute("href", "tel:18");
    await expect(warning.getByRole("link", { name: "112" })).toHaveAttribute("href", "tel:112");
  });

  test("ships a content security policy in the build", async ({ page }) => {
    await page.goto("/");
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  test("cycles the theme and remembers it after a reload", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const html = page.locator("html");
    const toggle = page.getByRole("button", { name: /Changer de thème/ });
    await expect(html).toHaveAttribute("data-theme", "light");
    await toggle.click();
    await expect(html).toHaveAttribute("data-theme-preference", "light");
    await toggle.click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
  });

  test("follows the system theme in automatic mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("is usable with the keyboard only", async ({ page, browserName, isMobile }) => {
    test.skip(isMobile, "no physical keyboard on the mobile profiles");
    test.skip(
      browserName === "webkit",
      "WebKit skips links on Tab unless the OS setting is enabled; covered by Chromium and Firefox",
    );
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Aller au contenu" })).toBeFocused();
    await page.keyboard.press("Tab");
    const toggle = page.getByRole("button", { name: /Changer de thème/ });
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "light");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`has no automatic accessibility violation (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test("still renders when local storage is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("blocked");
        },
      });
    });
    await page.goto("/");
    const toggle = page.getByRole("button", { name: /Changer de thème/ });
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "light");
  });
});
