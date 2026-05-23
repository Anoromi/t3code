import { beforeEach, describe, expect, it } from "vitest";

import { useWorktreeTerminalPresenceStore } from "./worktreeTerminalPresenceStore";

describe("worktreeTerminalPresenceStore", () => {
  beforeEach(() => {
    useWorktreeTerminalPresenceStore.setState({
      openWorktreePaths: {},
    });
  });

  it("marks an open worktree path", () => {
    useWorktreeTerminalPresenceStore.getState().markOpen(" /tmp/project/worktrees/feature-a ");

    expect(useWorktreeTerminalPresenceStore.getState().openWorktreePaths).toEqual({
      "/tmp/project/worktrees/feature-a": true,
    });
  });

  it("replaces the set of open worktrees", () => {
    useWorktreeTerminalPresenceStore
      .getState()
      .replaceOpenWorktrees(["/tmp/project/worktrees/feature-a", "/tmp/project"]);

    expect(useWorktreeTerminalPresenceStore.getState().openWorktreePaths).toEqual({
      "/tmp/project/worktrees/feature-a": true,
      "/tmp/project": true,
    });
  });

  it("clears all open worktrees", () => {
    useWorktreeTerminalPresenceStore.setState({
      openWorktreePaths: {
        "/tmp/project": true,
      },
    });

    useWorktreeTerminalPresenceStore.getState().clearAll();

    expect(useWorktreeTerminalPresenceStore.getState().openWorktreePaths).toEqual({});
  });
});
