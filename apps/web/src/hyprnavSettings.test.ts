import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime";
import {
  DEFAULT_PROJECT_HYPRNAV_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildProjectHyprnavSyncJobs,
  computeRemovedHyprnavSlots,
  resolveActiveHyprnavLockTarget,
  validateProjectHyprnavSettings,
} from "./hyprnavSettings";
import type { Project, Thread, ThreadShell } from "./types";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");
const projectId = ProjectId.make("project-1");
const projectKey = scopedProjectKey(scopeProjectRef(localEnvironmentId, projectId));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: projectId,
    environmentId: localEnvironmentId,
    name: "Project",
    cwd: "/repo",
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-04-19T09:00:00.000Z",
    updatedAt: "2026-04-19T09:00:00.000Z",
    scripts: [],
    hyprnav: DEFAULT_PROJECT_HYPRNAV_SETTINGS,
    worktreeGroupTitles: [],
    ...overrides,
  };
}

function makeThreadShell(overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    codexThreadId: null,
    projectId,
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    error: null,
    createdAt: "2026-04-19T09:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-19T09:00:00.000Z",
    branch: null,
    worktreePath: null,
    forkOrigin: null,
    ...overrides,
  };
}

describe("hyprnavSettings", () => {
  it("validates duplicate project slots", () => {
    expect(
      validateProjectHyprnavSettings({
        bindings: [
          { id: "terminal", slot: 1, action: "worktree-terminal" },
          { id: "editor", slot: 1, action: "open-favorite-editor" },
        ],
      }).duplicateSlots,
    ).toEqual([1]);
  });

  it("validates empty shell commands", () => {
    expect(
      validateProjectHyprnavSettings({
        bindings: [{ id: "custom", slot: 3, action: "shell-command", command: "" }],
      }).emptyShellCommandBindingIds,
    ).toEqual(["custom"]);
  });

  it("emits clearSlots only when a slot number is removed", () => {
    expect(
      computeRemovedHyprnavSlots(
        {
          bindings: [
            { id: "terminal", slot: 1, action: "worktree-terminal" },
            { id: "editor", slot: 2, action: "open-favorite-editor" },
            { id: "custom", slot: 4, action: "shell-command", command: "old" },
          ],
        },
        {
          bindings: [
            { id: "terminal", slot: 7, action: "worktree-terminal" },
            { id: "editor", slot: 2, action: "open-favorite-editor" },
          ],
        },
      ),
    ).toEqual([1, 4]);
  });

  it("does not emit clearSlots when only actions or commands change", () => {
    expect(
      computeRemovedHyprnavSlots(
        {
          bindings: [{ id: "slot-1", slot: 1, action: "shell-command", command: "old" }],
        },
        {
          bindings: [{ id: "slot-1", slot: 1, action: "worktree-terminal" }],
        },
      ),
    ).toEqual([]);
  });

  it("locks the worktree environment for active worktree threads", () => {
    const activeThread = {
      environmentId: localEnvironmentId,
      projectId,
      worktreePath: "/repo/worktrees/feature-a",
    } satisfies Pick<Thread, "environmentId" | "projectId" | "worktreePath">;

    expect(
      buildProjectHyprnavSyncJobs({
        localEnvironmentId,
        projects: [makeProject()],
        threadShells: [],
        activeThread,
        clearSlotsByProjectKey: new Map(),
      }),
    ).toEqual([
      {
        environmentPath: "/repo/worktrees/feature-a",
        projectRoot: "/repo",
        hyprnav: DEFAULT_PROJECT_HYPRNAV_SETTINGS,
        clearSlots: [],
        lock: true,
      },
    ]);
  });

  it("resolves active lock targets from worktree paths", () => {
    const project = makeProject();

    expect(
      resolveActiveHyprnavLockTarget({
        localEnvironmentId,
        activeThread: makeThreadShell({ worktreePath: "/repo/worktrees/feature-a" }),
        project,
      }),
    ).toBe("/repo/worktrees/feature-a");
  });

  it("falls back to the project cwd when active threads have no worktree path", () => {
    const project = makeProject();

    expect(
      resolveActiveHyprnavLockTarget({
        localEnvironmentId,
        activeThread: makeThreadShell({ worktreePath: null }),
        project,
      }),
    ).toBe("/repo");
  });

  it("does not resolve lock targets for remote environments", () => {
    expect(
      resolveActiveHyprnavLockTarget({
        localEnvironmentId,
        activeThread: makeThreadShell({
          environmentId: remoteEnvironmentId,
          worktreePath: "/remote/worktree",
        }),
        project: makeProject({ environmentId: remoteEnvironmentId }),
      }),
    ).toBeNull();
  });

  it("locks the project root environment for active non-worktree threads", () => {
    const activeThread = {
      environmentId: localEnvironmentId,
      projectId,
      worktreePath: null,
    } satisfies Pick<Thread, "environmentId" | "projectId" | "worktreePath">;

    expect(
      buildProjectHyprnavSyncJobs({
        localEnvironmentId,
        projects: [makeProject()],
        threadShells: [],
        activeThread,
        clearSlotsByProjectKey: new Map(),
      })[0]?.environmentPath,
    ).toBe("/repo");
  });

  it("syncs passive worktrees without locking", () => {
    expect(
      buildProjectHyprnavSyncJobs({
        localEnvironmentId,
        projects: [makeProject()],
        threadShells: [makeThreadShell({ worktreePath: "/repo/worktrees/feature-a" })],
        activeThread: null,
        clearSlotsByProjectKey: new Map(),
      }),
    ).toEqual([
      {
        environmentPath: "/repo/worktrees/feature-a",
        projectRoot: "/repo",
        hyprnav: DEFAULT_PROJECT_HYPRNAV_SETTINGS,
        clearSlots: [],
        lock: false,
      },
    ]);
  });

  it("ignores remote environment worktrees and attaches clearSlots to local jobs", () => {
    expect(
      buildProjectHyprnavSyncJobs({
        localEnvironmentId,
        projects: [
          makeProject(),
          makeProject({
            environmentId: remoteEnvironmentId,
            id: projectId,
          }),
        ],
        threadShells: [
          makeThreadShell({ worktreePath: "/repo/worktrees/feature-a" }),
          makeThreadShell({
            environmentId: remoteEnvironmentId,
            worktreePath: "/remote/worktree",
          }),
        ],
        activeThread: null,
        clearSlotsByProjectKey: new Map([[projectKey, [4]]]),
      }).map((job) => ({
        environmentPath: job.environmentPath,
        clearSlots: job.clearSlots,
      })),
    ).toEqual([{ environmentPath: "/repo/worktrees/feature-a", clearSlots: [4] }]);
  });
});
