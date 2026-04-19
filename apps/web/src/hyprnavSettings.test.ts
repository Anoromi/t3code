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
  computeRemovedHyprnavBindings,
  projectHyprnavNeedsCorkdiffConnection,
  resolveActiveHyprnavLockTarget,
  resolveActiveHyprnavSyncTarget,
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
  it("validates duplicate project slots within the same scope only", () => {
    expect(
      validateProjectHyprnavSettings({
        bindings: [
          { id: "terminal", slot: 1, scope: "worktree", action: "worktree-terminal" },
          { id: "editor", slot: 1, scope: "worktree", action: "open-favorite-editor" },
          { id: "custom", slot: 1, scope: "project", action: "shell-command", command: "tmux" },
        ],
      }).duplicateScopedSlots,
    ).toEqual([{ scope: "worktree", slot: 1 }]);
  });

  it("validates empty shell commands", () => {
    expect(
      validateProjectHyprnavSettings({
        bindings: [
          { id: "custom", slot: 3, scope: "thread", action: "shell-command", command: "" },
        ],
      }).emptyShellCommandBindingIds,
    ).toEqual(["custom"]);
  });

  it("emits removed bindings when slot or scope ownership changes", () => {
    expect(
      computeRemovedHyprnavBindings(
        {
          bindings: [
            { id: "terminal", slot: 1, scope: "worktree", action: "worktree-terminal" },
            { id: "editor", slot: 2, scope: "project", action: "open-favorite-editor" },
            { id: "custom", slot: 8, scope: "thread", action: "shell-command", command: "old" },
          ],
        },
        {
          bindings: [
            { id: "terminal", slot: 7, scope: "worktree", action: "worktree-terminal" },
            { id: "editor", slot: 2, scope: "project", action: "open-favorite-editor" },
            { id: "custom", slot: 8, scope: "project", action: "shell-command", command: "new" },
          ],
        },
      ),
    ).toEqual([
      { scope: "thread", slot: 8 },
      { scope: "worktree", slot: 1 },
    ]);
  });

  it("does not emit removed bindings when only actions or commands change", () => {
    expect(
      computeRemovedHyprnavBindings(
        {
          bindings: [
            { id: "slot-1", slot: 1, scope: "worktree", action: "shell-command", command: "old" },
          ],
        },
        {
          bindings: [{ id: "slot-1", slot: 1, scope: "worktree", action: "worktree-terminal" }],
        },
      ),
    ).toEqual([]);
  });

  it("resolves active sync targets from project, worktree, and thread identity", () => {
    const activeThread = {
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      projectId,
      worktreePath: "/repo/worktrees/feature-a",
    } satisfies Pick<Thread, "id" | "environmentId" | "projectId" | "worktreePath">;

    expect(
      resolveActiveHyprnavSyncTarget({
        localEnvironmentId,
        activeThread,
        project: makeProject(),
      }),
    ).toEqual({
      projectRoot: "/repo",
      worktreePath: "/repo/worktrees/feature-a",
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("resolves legacy lock targets from worktree paths", () => {
    const project = makeProject();

    expect(
      resolveActiveHyprnavLockTarget({
        localEnvironmentId,
        activeThread: makeThreadShell({ worktreePath: "/repo/worktrees/feature-a" }),
        project,
      }),
    ).toBe("/repo/worktrees/feature-a");
  });

  it("does not resolve sync targets for remote environments", () => {
    expect(
      resolveActiveHyprnavSyncTarget({
        localEnvironmentId,
        activeThread: {
          id: ThreadId.make("thread-1"),
          environmentId: remoteEnvironmentId,
          projectId,
          worktreePath: "/remote/worktree",
        },
        project: makeProject({ environmentId: remoteEnvironmentId }),
      }),
    ).toBeNull();
  });

  it("builds project, worktree, and thread jobs for known local threads", () => {
    expect(
      buildProjectHyprnavSyncJobs({
        localEnvironmentId,
        projects: [makeProject()],
        threadShells: [
          makeThreadShell({
            id: ThreadId.make("thread-1"),
            worktreePath: "/repo/worktrees/feature-a",
          }),
          makeThreadShell({
            id: ThreadId.make("thread-2"),
            worktreePath: "/repo/worktrees/feature-a",
          }),
        ],
        activeThread: {
          id: ThreadId.make("thread-2"),
          environmentId: localEnvironmentId,
          projectId,
          worktreePath: "/repo/worktrees/feature-a",
        },
        clearBindingsByProjectKey: new Map([[projectKey, [{ scope: "thread", slot: 8 }]]]),
      }),
    ).toEqual([
      {
        projectRoot: "/repo",
        worktreePath: "/repo/worktrees/feature-a",
        threadId: ThreadId.make("thread-1"),
        hyprnav: DEFAULT_PROJECT_HYPRNAV_SETTINGS,
        clearBindings: [{ scope: "thread", slot: 8 }],
        lock: false,
      },
      {
        projectRoot: "/repo",
        worktreePath: "/repo/worktrees/feature-a",
        threadId: ThreadId.make("thread-2"),
        hyprnav: DEFAULT_PROJECT_HYPRNAV_SETTINGS,
        clearBindings: [{ scope: "thread", slot: 8 }],
        lock: true,
      },
    ]);
  });

  it("falls back to a project-root job when no local threads are known", () => {
    expect(
      buildProjectHyprnavSyncJobs({
        localEnvironmentId,
        projects: [makeProject()],
        threadShells: [],
        activeThread: null,
        clearBindingsByProjectKey: new Map([[projectKey, [{ scope: "project", slot: 2 }]]]),
      }),
    ).toEqual([
      {
        projectRoot: "/repo",
        worktreePath: null,
        threadId: null,
        hyprnav: DEFAULT_PROJECT_HYPRNAV_SETTINGS,
        clearBindings: [{ scope: "project", slot: 2 }],
        lock: false,
      },
    ]);
  });

  it("detects when Hyprnav settings need a Corkdiff connection", () => {
    expect(projectHyprnavNeedsCorkdiffConnection(DEFAULT_PROJECT_HYPRNAV_SETTINGS)).toBe(true);
    expect(
      projectHyprnavNeedsCorkdiffConnection({
        bindings: [
          { id: "custom", slot: 5, scope: "project", action: "shell-command", command: "tmux" },
        ],
      }),
    ).toBe(false);
  });
});
