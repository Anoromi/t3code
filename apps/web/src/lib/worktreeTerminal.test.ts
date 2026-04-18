import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DesktopBridge, ProjectId } from "@t3tools/contracts";
import { useWorktreeTerminalPresenceStore } from "../worktreeTerminalPresenceStore";

const getStateMock = vi.fn();
const selectProjectsAcrossEnvironmentsMock = vi.fn();
const selectThreadsAcrossEnvironmentsMock = vi.fn();
const toastAddMock = vi.fn();

vi.mock("../store", () => ({
  useStore: {
    getState: getStateMock,
  },
  selectProjectsAcrossEnvironments: selectProjectsAcrossEnvironmentsMock,
  selectThreadsAcrossEnvironments: selectThreadsAcrossEnvironmentsMock,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: {
    add: toastAddMock,
  },
}));

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

describe("worktreeTerminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStateMock.mockReturnValue({});
    selectProjectsAcrossEnvironmentsMock.mockReturnValue([
      {
        id: ProjectId.make("project-1"),
        environmentId: "environment-local",
        cwd: "/tmp/project",
      },
    ]);
    selectThreadsAcrossEnvironmentsMock.mockReturnValue([
      {
        id: "thread-1",
        environmentId: "environment-local",
        projectId: ProjectId.make("project-1"),
        worktreePath: "/tmp/project/worktrees/feature-a",
      },
    ]);
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
    useWorktreeTerminalPresenceStore.setState({
      openWorktreePaths: {},
    });
  });

  it("shows a desktop-only toast when the desktop bridge is unavailable", async () => {
    const { openWorktreeTerminalForProject } = await import("./worktreeTerminal");

    await openWorktreeTerminalForProject({
      projectId: ProjectId.make("project-1"),
      worktreePath: null,
    });

    expect(toastAddMock).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to open worktree terminal",
      description: "Worktree terminal is only available in the desktop app.",
    });
  });

  it("falls back to project cwd when no worktree is active", async () => {
    const openWorktreeTerminal = vi.fn(async () => ({
      worktreePath: "/tmp/project/worktrees/feature-a",
    }));
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        openWorktreeTerminal,
      } as unknown as DesktopBridge,
    });

    const { openWorktreeTerminalForProject } = await import("./worktreeTerminal");

    await openWorktreeTerminalForProject({
      projectId: ProjectId.make("project-1"),
      worktreePath: null,
    });

    expect(openWorktreeTerminal).toHaveBeenCalledWith({
      cwd: "/tmp/project",
    });
    expect(toastAddMock).not.toHaveBeenCalled();
    expect(useWorktreeTerminalPresenceStore.getState().openWorktreePaths).toEqual({
      "/tmp/project/worktrees/feature-a": true,
    });
  });
});
