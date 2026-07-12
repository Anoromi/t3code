import "../index.css";

import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useEffect, useState } from "react";
import { render } from "vitest-browser-react";

const { openInEditorSpy, requestGitActionSpy, runProjectScriptSpy } = vi.hoisted(() => ({
  openInEditorSpy: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  requestGitActionSpy: vi.fn(),
  runProjectScriptSpy: vi.fn(),
}));

vi.mock("../lib/sourceControlActions", () => ({
  useSourceControlActionRunning: () => false,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/project-actions",
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => openInEditorSpy,
}));
vi.mock("./chat/OpenInPicker", () => ({
  resolveOpenInOptions: () => [
    {
      label: "VS Code",
      value: "vscode",
      Icon: (props: { className?: string }) => <span {...props}>E</span>,
    },
  ],
}));

import { isAnyCommandSurfaceOpen } from "../commandSurface";
import { resolveShortcutCommand } from "../keybindings";
import { ProjectActionsPanel } from "./ProjectActionsPanel";

const KEYBINDINGS: ResolvedKeybindingsConfig = [
  {
    command: "projectActions.toggle",
    shortcut: {
      key: "p",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
  },
];

const SCRIPT: ProjectScript = {
  id: "verify",
  name: "Verify project",
  command: "vp check",
  icon: "test",
  runOnWorktreeCreate: false,
  autoOpenPreview: false,
};

function Harness() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isAnyCommandSurfaceOpen()) return;
      if (
        resolveShortcutCommand(event, KEYBINDINGS, {
          platform: "Linux",
          context: { terminalFocus: false },
        }) !== "projectActions.toggle"
      ) {
        return;
      }
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <>
      <button type="button">Workspace</button>
      <ProjectActionsPanel
        availableEditors={["vscode"]}
        environmentId={"environment-test" as never}
        gitCwd="/workspace/project"
        keybindings={KEYBINDINGS}
        onOpenChange={setOpen}
        onRequestGitAction={requestGitActionSpy}
        onRunProjectScript={runProjectScriptSpy}
        open={open}
        scripts={[SCRIPT]}
      />
    </>
  );
}

describe("ProjectActionsPanel", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("opens with Mod+P, searches, and runs a configured action once", async () => {
    const screen = await render(<Harness />);
    try {
      await page.getByRole("button", { name: "Workspace" }).click();
      await userEvent.keyboard("{Control>}p{/Control}");
      await expect.element(page.getByRole("dialog", { name: "Project actions" })).toBeVisible();
      const input = page.getByRole("combobox", { name: "Search project actions" });
      await expect.element(input).toHaveFocus();
      await input.fill("verify");
      await userEvent.keyboard("{Enter}");
      expect(runProjectScriptSpy).toHaveBeenCalledTimes(1);
      expect(runProjectScriptSpy).toHaveBeenCalledWith(SCRIPT);
    } finally {
      await screen.unmount();
    }
  });

  it("routes commit through the existing Git action request flow", async () => {
    const screen = await render(<Harness />);
    try {
      await userEvent.keyboard("{Control>}p{/Control}");
      const input = page.getByRole("combobox", { name: "Search project actions" });
      await input.fill("commit");
      await page.getByRole("option", { name: /^Commit feature\/project-actions$/ }).click();
      expect(requestGitActionSpy).toHaveBeenCalledWith("commit");
      await expect
        .element(page.getByRole("dialog", { name: "Project actions" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("opens the selected editor and restores focus after Escape", async () => {
    const screen = await render(<Harness />);
    try {
      const workspace = page.getByRole("button", { name: "Workspace" });
      await workspace.click();
      await userEvent.keyboard("{Control>}p{/Control}");
      const input = page.getByRole("combobox", { name: "Search project actions" });
      await input.fill("VS Code");
      await page.getByRole("option", { name: /Open in VS Code/ }).click();
      expect(openInEditorSpy).toHaveBeenCalledWith({
        environmentId: "environment-test",
        input: { cwd: "/workspace/project", editor: "vscode" },
      });

      await workspace.click();
      await userEvent.keyboard("{Control>}p{/Control}");
      await userEvent.keyboard("{Escape}");
      await expect.element(workspace).toHaveFocus();
    } finally {
      await screen.unmount();
    }
  });

  it("does not stack over another command surface", async () => {
    const screen = await render(
      <>
        <div data-command-surface="command-palette" />
        <Harness />
      </>,
    );
    try {
      await userEvent.keyboard("{Control>}p{/Control}");
      await expect
        .element(page.getByRole("dialog", { name: "Project actions" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
