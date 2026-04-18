import { expect, test } from "@playwright/test";

import { launchDesktopE2eApp } from "./fixtures/electronApp.js";

test("keeps server-thread worktree selection scoped to pre-send state", async ({
  page: _page,
}, testInfo) => {
  const desktop = await launchDesktopE2eApp();

  try {
    const composer = desktop.page.locator('[data-testid="composer-editor"]');
    await expect(composer).toBeVisible();
    await expect(desktop.page.getByRole("button", { name: "Workspace" })).toBeVisible();

    await composer.fill("/worktree testing");
    await desktop.page.locator('[data-composer-item-id="named-worktree:testing"]').click();
    await expect(composer).toHaveText("");

    await composer.fill("create the testing worktree");
    await desktop.page.getByRole("button", { name: "Send message" }).click();

    await expect
      .poll(() => desktop.readWorktreePath("testing"), { timeout: 30_000 })
      .not.toBeNull();
    await expect(desktop.page.getByText("E2E response")).toBeVisible();
    await expect(desktop.page.getByText("testing", { exact: true })).toBeVisible();

    await composer.fill("/worktree");
    await expect(desktop.page.locator('[data-composer-item-id^="named-worktree:"]')).toHaveCount(0);

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

test("opens navigation and terminal UI without losing active worktree thread context", async ({
  page: _page,
}, testInfo) => {
  const desktop = await launchDesktopE2eApp({
    fakeExecutables: ["ghostty", "hyprctl", "hyprnav"],
  });

  try {
    const composer = desktop.page.locator('[data-testid="composer-editor"]');
    await expect(composer).toBeVisible();
    await composer.fill("/worktree testing");
    await desktop.page.locator('[data-composer-item-id="named-worktree:testing"]').click();
    await composer.fill("create the testing worktree");
    await desktop.page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(() => desktop.readWorktreePath("testing"), { timeout: 30_000 })
      .not.toBeNull();

    await desktop.page.keyboard.press("Control+E");
    await expect(desktop.page.getByLabel("Navigation command menu")).toBeVisible();
    await expect(desktop.page.getByText("testing", { exact: true })).toBeVisible();
    await desktop.page.keyboard.press("Escape");

    await desktop.page.getByRole("button", { name: "Toggle terminal drawer" }).click();
    const terminalSurface = desktop.page.locator('[data-terminal-surface="app"]');
    await expect(terminalSurface).toBeVisible();

    await desktop.page.getByRole("button", { name: /^Split Terminal/ }).click();
    await expect(desktop.page.getByText("Split 1", { exact: true })).toBeVisible();
    await expect(desktop.page.getByText("Terminal 2", { exact: true })).toBeVisible();

    await desktop.page.getByRole("button", { name: /^New Terminal/ }).click();
    await expect(desktop.page.getByText("Terminal 3", { exact: true })).toBeVisible();

    await desktop.page.getByRole("button", { name: /^Close Terminal \(/ }).click();
    await expect(terminalSurface).toBeVisible();
    await expect(desktop.page.getByText("testing", { exact: true })).toBeVisible();

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
