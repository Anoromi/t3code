import { expect, test } from "@playwright/test";

import { launchDesktopE2eApp } from "./fixtures/electronApp.js";

test("launches desktop app and sends a message in a new thread", async ({
  page: _page,
}, testInfo) => {
  const desktop = await launchDesktopE2eApp();

  try {
    const composer = desktop.page.locator('[data-testid="composer-editor"]');
    await expect(composer).toBeVisible();
    const main = desktop.page.getByRole("main");
    await expect(main).toBeVisible();
    await expect(desktop.page.getByRole("combobox", { name: "Workspace" })).toBeVisible();
    await expect
      .poll(() =>
        desktop.page.evaluate(() =>
          Boolean((window as Window & { desktopBridge?: unknown }).desktopBridge),
        ),
      )
      .toBe(true);

    await desktop.page.getByTestId("new-thread-button").click({ force: true });
    await expect(composer).toBeVisible();

    const message = "desktop smoke new thread message";
    await composer.fill(message);
    await desktop.page.getByRole("button", { name: "Send message" }).click();

    await expect(main.getByText(message)).toBeVisible();
    await expect(main.getByText("E2E response")).toBeVisible();
    await expect(desktop.page.locator('[data-testid^="thread-row-"]').first()).toBeVisible();
    await expect(composer).toBeVisible();

    desktop.expectNoFatalLogs();
  } catch (error) {
    await testInfo.attach("desktop-e2e.log", {
      body: desktop.logs(),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await desktop.cleanup();
  }
});
