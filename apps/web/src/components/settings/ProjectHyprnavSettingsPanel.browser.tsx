import "../../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import type { ProjectHyprnavSettings } from "@t3tools/contracts";

import { HyprnavEditor } from "./ProjectHyprnavSettingsPanel";

describe("HyprnavEditor browser", () => {
  it("renders bindings, validates edits, adds rows, and saves the parsed settings", async () => {
    const onSave = vi.fn(async (_settings: ProjectHyprnavSettings) => "Saved and synchronized.");
    await render(
      <HyprnavEditor
        title="Hyprnav defaults"
        description="Keyboard navigation bindings"
        initialSettings={{
          bindings: [
            {
              id: "notify",
              slot: 3,
              scope: "thread",
              workspace: { mode: "managed" },
              action: "shell-command",
              command: "",
            },
          ],
        }}
        inherited={false}
        disabled={false}
        onReset={null}
        onSave={onSave}
      />,
    );

    await expect.element(page.getByRole("heading", { name: "Hyprnav defaults" })).toBeVisible();
    const save = page.getByRole("button", { name: "Save and apply" });
    await expect.element(save).toBeDisabled();
    await expect.element(page.getByText("Shell command bindings need a command.")).toBeVisible();

    await page.getByRole("textbox", { name: "Command for notify" }).fill("notify-send ready");
    await expect.element(save).toBeEnabled();
    await save.click();
    await expect.poll(() => onSave.mock.calls.length).toBe(1);
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      bindings: [
        {
          id: "notify",
          slot: 3,
          scope: "thread",
          workspace: { mode: "managed" },
          action: "shell-command",
          command: "notify-send ready",
        },
      ],
    });
    await expect.element(page.getByText("Saved and synchronized.")).toBeVisible();

    await page.getByRole("button", { name: "Add binding" }).click();
    await expect.element(page.getByRole("button", { name: /Remove custom-/ })).toBeVisible();
  });
});
