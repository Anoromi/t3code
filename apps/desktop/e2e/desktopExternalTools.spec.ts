import { expect, test } from "@playwright/test";

import { launchDesktopE2eApp } from "./fixtures/electronApp.js";

async function createTestingWorktree(desktop: Awaited<ReturnType<typeof launchDesktopE2eApp>>) {
  const composer = desktop.page.locator('[data-testid="composer-editor"]');
  await expect(composer).toBeVisible();
  await composer.fill("/worktree testing");
  await desktop.page.locator('[data-composer-item-id="named-worktree:testing"]').click();
  await composer.fill("create the testing worktree");
  await desktop.page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => desktop.readWorktreePath("testing"), { timeout: 30_000 }).not.toBeNull();
}

test("opens and focuses external Corkdiff and worktree terminals through desktop-owned tools", async ({
  page: _page,
}, testInfo) => {
  const desktop = await launchDesktopE2eApp({
    fakeExecutables: ["ghostty", "hyprctl", "hyprnav"],
  });

  try {
    await createTestingWorktree(desktop);

    await desktop.page.keyboard.press("Control+D");
    await expect
      .poll(async () => {
        const invocations = await desktop.readLoggedProcessInvocations();
        return invocations.filter(
          (invocation) =>
            invocation.name === "hyprnav" &&
            invocation.args.includes("spawn") &&
            invocation.args.some((arg) => arg.includes("nvim")),
        ).length;
      })
      .toBe(1);

    await desktop.page.keyboard.press("Control+D");
    await expect
      .poll(async () => {
        const invocations = await desktop.readLoggedProcessInvocations();
        return invocations.filter(
          (invocation) =>
            invocation.name === "hyprnav" &&
            invocation.args.includes("spawn") &&
            invocation.args.some((arg) => arg.includes("nvim")),
        ).length;
      })
      .toBe(1);

    await desktop.page.keyboard.press("Control+T");
    await expect
      .poll(async () => {
        const invocations = await desktop.readLoggedProcessInvocations();
        return invocations.some(
          (invocation) =>
            invocation.name === "hyprnav" &&
            invocation.args.includes("spawn") &&
            invocation.args.some((arg) => arg.includes("ghostty-worktree")),
        );
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
