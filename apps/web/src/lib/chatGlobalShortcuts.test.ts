import { describe, expect, it } from "vitest";
import { ProjectId } from "@t3tools/contracts";

import { resolveChatGlobalShortcutAction } from "./chatGlobalShortcuts";

const projectId = ProjectId.make("project-1");

describe("resolveChatGlobalShortcutAction", () => {
  it("returns a worktree-scoped terminal action for the active thread", () => {
    expect(
      resolveChatGlobalShortcutAction({
        command: "terminal.worktree.open",
        activeThread: {
          projectId,
          worktreePath: "/tmp/project/worktrees/feature-a",
        },
        activeDraftThread: null,
        defaultProjectId: null,
      }),
    ).toEqual({
      type: "terminal.worktree.open",
      projectId,
      worktreePath: "/tmp/project/worktrees/feature-a",
    });
  });

  it("falls back to draft thread context for worktree terminal action", () => {
    expect(
      resolveChatGlobalShortcutAction({
        command: "terminal.worktree.open",
        activeThread: null,
        activeDraftThread: {
          projectId,
          worktreePath: null,
        },
        defaultProjectId: null,
      }),
    ).toEqual({
      type: "terminal.worktree.open",
      projectId,
      worktreePath: null,
    });
  });

  it("returns null when no project context is available", () => {
    expect(
      resolveChatGlobalShortcutAction({
        command: "terminal.worktree.open",
        activeThread: null,
        activeDraftThread: null,
        defaultProjectId: null,
      }),
    ).toBeNull();
  });
});
