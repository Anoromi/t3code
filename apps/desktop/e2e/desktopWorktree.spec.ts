import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";

import { launchDesktopE2eApp, readTestingWorktreePath } from "./fixtures/electronApp.js";

test("creates a named worktree from slash command before first send", async ({
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
      .poll(() => readTestingWorktreePath(desktop.repoDir), {
        message: "testing worktree should be created",
        timeout: 30_000,
      })
      .not.toBeNull();

    const worktreePath = await readTestingWorktreePath(desktop.repoDir);
    expect(worktreePath).not.toBeNull();
    await expect(desktop.page.getByText("E2E response")).toBeVisible();
    await expect(desktop.page.getByText("testing", { exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        if (!worktreePath) return false;
        await fs.access(worktreePath);
        return true;
      })
      .toBe(true);

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
