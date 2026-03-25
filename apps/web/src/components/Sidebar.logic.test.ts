import {
  type OrchestrationLatestTurn,
  type OrchestrationWorktreeGroupTitle,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createThreadJumpHintVisibilityController,
  getVisibleSidebarThreadIds,
  resolveAdjacentThreadId,
  buildSidebarProjectTree,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  buildSidebarProjectThreadEntries,
  detectWorktreeGroupBirths,
  flattenSidebarProjectThreadIds,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  orderItemsByPreferredIds,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldDisableWorktreeTitleRegenerate,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";

function makeGroupedProject(
  worktreeGroupTitles: Project["worktreeGroupTitles"] = [],
  overrides: Partial<Project> = {},
): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    expanded: true,
    scripts: [],
    worktreeGroupTitles,
    ...overrides,
  };
}

function makeWorktreeGroupTitle(
  overrides: Partial<OrchestrationWorktreeGroupTitle> = {},
): OrchestrationWorktreeGroupTitle {
  return {
    worktreePath: "/tmp/worktrees/feature-a",
    title: "Feature title",
    status: "ready",
    sourceThreadId: ThreadId.makeUnsafe("thread-source"),
    generationId: "generation-1" as never,
    updatedAt: "2026-02-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeGroupedThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    forkOrigin: null,
    ...overrides,
  };
}

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(true);
  });
});

describe("createThreadJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("buildSidebarProjectThreadEntries", () => {
  it("groups threads that share the same worktree path", () => {
    const entries = buildSidebarProjectThreadEntries(makeGroupedProject(), [
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-02-13T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-02-14T00:00:00.000Z",
        worktreePath: " /tmp/worktrees/feature-a ",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "worktree-group",
      groupKey: "project-1::/tmp/worktrees/feature-a",
      label: "feature-a",
      fallbackLabel: "feature-a",
      positionCreatedAt: "2026-02-13T00:00:00.000Z",
      worktreeTitleStatus: "absent",
      worktreeTitleUpdatedAt: null,
      worktreePath: "/tmp/worktrees/feature-a",
    });
    expect(
      entries[0]?.kind === "worktree-group" ? entries[0].threads.map((thread) => thread.id) : [],
    ).toEqual([ThreadId.makeUnsafe("thread-2"), ThreadId.makeUnsafe("thread-1")]);
  });

  it("keeps single-thread worktrees as flat rows", () => {
    const entries = buildSidebarProjectThreadEntries(makeGroupedProject(), [
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/worktrees/feature-a",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "thread",
      positionCreatedAt: "2026-02-13T00:00:00.000Z",
    });
  });

  it("does not group threads without a worktree path", () => {
    const entries = buildSidebarProjectThreadEntries(makeGroupedProject(), [
      makeGroupedThread({ id: ThreadId.makeUnsafe("thread-1"), worktreePath: null }),
      makeGroupedThread({ id: ThreadId.makeUnsafe("thread-2"), worktreePath: null }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["thread", "thread"]);
  });

  it("keeps grouping project-local when worktree strings repeat in another project", () => {
    const entries = buildSidebarProjectThreadEntries(makeGroupedProject(), [
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        worktreePath: "/tmp/worktrees/shared",
      }),
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-2"),
        projectId: ProjectId.makeUnsafe("project-2"),
        worktreePath: "/tmp/worktrees/shared",
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["thread", "thread"]);
  });

  it("anchors group ordering to the earliest thread on that worktree", () => {
    const entries = buildSidebarProjectThreadEntries(makeGroupedProject(), [
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-old"),
        createdAt: "2026-02-10T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-new"),
        createdAt: "2026-02-15T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-mid"),
        createdAt: "2026-02-12T00:00:00.000Z",
      }),
    ]);

    expect(
      entries.map((entry) => (entry.kind === "thread" ? entry.thread.id : entry.groupKey)),
    ).toEqual([ThreadId.makeUnsafe("thread-mid"), "project-1::/tmp/worktrees/feature-a"]);
  });

  it("breaks ties deterministically for grouped entries", () => {
    const entries = buildSidebarProjectThreadEntries(makeGroupedProject(), [
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-a1"),
        createdAt: "2026-02-10T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/a",
      }),
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-a2"),
        createdAt: "2026-02-11T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/a",
      }),
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-b1"),
        createdAt: "2026-02-10T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/b",
      }),
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-b2"),
        createdAt: "2026-02-12T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/b",
      }),
    ]);

    expect(
      entries.map((entry) =>
        entry.kind === "worktree-group" ? entry.worktreePath : entry.thread.id,
      ),
    ).toEqual(["/tmp/worktrees/b", "/tmp/worktrees/a"]);
  });

  it("uses the generated worktree title when metadata is ready", () => {
    const entries = buildSidebarProjectThreadEntries(
      makeGroupedProject([makeWorktreeGroupTitle()]),
      [
        makeGroupedThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-02-13T00:00:00.000Z",
          worktreePath: "/tmp/worktrees/feature-a",
        }),
        makeGroupedThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-02-14T00:00:00.000Z",
          worktreePath: "/tmp/worktrees/feature-a",
        }),
      ],
    );

    expect(entries[0]).toMatchObject({
      kind: "worktree-group",
      label: "Feature title",
      fallbackLabel: "feature-a",
      worktreeTitleStatus: "ready",
      worktreeTitleUpdatedAt: "2026-02-15T00:00:00.000Z",
    });
  });

  it("keeps the fallback label while title generation is pending", () => {
    const entries = buildSidebarProjectThreadEntries(
      makeGroupedProject([
        makeWorktreeGroupTitle({
          title: null,
          status: "pending",
          updatedAt: "2026-02-16T00:00:00.000Z",
        }),
      ]),
      [
        makeGroupedThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-02-13T00:00:00.000Z",
          worktreePath: "/tmp/worktrees/feature-a",
        }),
        makeGroupedThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-02-14T00:00:00.000Z",
          worktreePath: "/tmp/worktrees/feature-a",
        }),
      ],
    );

    expect(entries[0]).toMatchObject({
      kind: "worktree-group",
      label: "feature-a",
      fallbackLabel: "feature-a",
      worktreeTitleStatus: "pending",
      worktreeTitleUpdatedAt: "2026-02-16T00:00:00.000Z",
    });
  });
});

describe("detectWorktreeGroupBirths", () => {
  it("detects a visible flat thread becoming a visible worktree group", () => {
    const previousEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/worktrees/feature-a",
      }),
    ]);
    const currentEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-02-14T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
    ]);

    expect(detectWorktreeGroupBirths(previousEntries, currentEntries)).toEqual([
      {
        groupKey: "project-1::/tmp/worktrees/feature-a",
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/worktrees/feature-a",
      },
    ]);
  });

  it("does not detect births on initial render", () => {
    const currentEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-02-14T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
    ]);

    expect(detectWorktreeGroupBirths([], currentEntries)).toEqual([]);
  });

  it("does not detect a birth when the previous state already had a group", () => {
    const previousEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-02-14T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
    ]);
    const currentEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-02-14T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        createdAt: "2026-02-15T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
    ]);

    expect(detectWorktreeGroupBirths(previousEntries, currentEntries)).toEqual([]);
  });

  it("does not detect births for null worktree paths", () => {
    const previousEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({ id: ThreadId.makeUnsafe("thread-1"), worktreePath: null }),
    ]);
    const currentEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({ id: ThreadId.makeUnsafe("thread-1"), worktreePath: null }),
      makeThread({ id: ThreadId.makeUnsafe("thread-2"), worktreePath: null }),
    ]);

    expect(detectWorktreeGroupBirths(previousEntries, currentEntries)).toEqual([]);
  });

  it("does not detect a birth when the transition is not visible in the rendered slice", () => {
    const previousEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-02-20T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-02-19T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        createdAt: "2026-02-18T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-4"),
        createdAt: "2026-02-17T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-5"),
        createdAt: "2026-02-16T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-6"),
        createdAt: "2026-02-15T00:00:00.000Z",
      }),
    ]).slice(0, 6);
    const currentEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-02-20T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-02-19T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        createdAt: "2026-02-18T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-4"),
        createdAt: "2026-02-17T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-5"),
        createdAt: "2026-02-16T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-6"),
        createdAt: "2026-02-15T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-hidden-old"),
        createdAt: "2026-02-01T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/hidden",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-hidden-new"),
        createdAt: "2026-02-14T12:00:00.000Z",
        worktreePath: "/tmp/worktrees/hidden",
      }),
    ]).slice(0, 6);

    expect(detectWorktreeGroupBirths(previousEntries, currentEntries)).toEqual([]);
  });

  it("returns births in deterministic current-entry order", () => {
    const previousEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({
        id: ThreadId.makeUnsafe("thread-a"),
        createdAt: "2026-02-10T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-b"),
        createdAt: "2026-02-09T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/b",
      }),
    ]);
    const currentEntries = buildSidebarProjectThreadEntries(makeProject(), [
      makeThread({
        id: ThreadId.makeUnsafe("thread-a"),
        createdAt: "2026-02-10T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-a2"),
        createdAt: "2026-02-11T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-b"),
        createdAt: "2026-02-09T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/b",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-b2"),
        createdAt: "2026-02-12T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/b",
      }),
    ]);

    expect(detectWorktreeGroupBirths(previousEntries, currentEntries)).toEqual([
      {
        groupKey: "project-1::/tmp/worktrees/a",
        sourceThreadId: ThreadId.makeUnsafe("thread-a"),
        worktreePath: "/tmp/worktrees/a",
      },
      {
        groupKey: "project-1::/tmp/worktrees/b",
        sourceThreadId: ThreadId.makeUnsafe("thread-b"),
        worktreePath: "/tmp/worktrees/b",
      },
    ]);
  });
});

describe("flattenSidebarProjectThreadIds", () => {
  it("returns thread ids in visual order across grouped and ungrouped entries", () => {
    const entries = buildSidebarProjectThreadEntries(makeGroupedProject(), [
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-02-13T00:00:00.000Z",
      }),
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-2"),
        createdAt: "2026-02-12T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
      makeGroupedThread({
        id: ThreadId.makeUnsafe("thread-3"),
        createdAt: "2026-02-14T00:00:00.000Z",
        worktreePath: "/tmp/worktrees/feature-a",
      }),
    ]);

    expect(flattenSidebarProjectThreadIds(entries)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveSidebarNewThreadSeedContext", () => {
  it("inherits the active server thread context when creating a new thread in the same project", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      branch: "effect-atom",
      worktreePath: null,
      envMode: "local",
    });
  });

  it("prefers the active draft thread context when it matches the target project", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: {
          projectId: "project-1",
          branch: "feature/new-draft",
          worktreePath: "/repo/worktree",
          envMode: "worktree",
        },
      }),
    ).toEqual({
      branch: "feature/new-draft",
      worktreePath: "/repo/worktree",
      envMode: "worktree",
    });
  });

  it("falls back to the default env mode when there is no matching active thread context", () => {
    expect(
      resolveSidebarNewThreadSeedContext({
        projectId: "project-2",
        defaultEnvMode: "worktree",
        activeThread: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      envMode: "worktree",
    });
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.makeUnsafe("project-1"), name: "One" },
        { id: ProjectId.makeUnsafe("project-2"), name: "Two" },
        { id: ProjectId.makeUnsafe("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.makeUnsafe("project-3"),
        ProjectId.makeUnsafe("project-missing"),
        ProjectId.makeUnsafe("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-3"),
      ProjectId.makeUnsafe("project-1"),
      ProjectId.makeUnsafe("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.makeUnsafe("project-1"), name: "One" },
        { id: ProjectId.makeUnsafe("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.makeUnsafe("project-2"),
        ProjectId.makeUnsafe("project-1"),
        ProjectId.makeUnsafe("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });
});

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("returns only the rendered visible thread order across projects", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          renderedThreadIds: [
            ThreadId.makeUnsafe("thread-12"),
            ThreadId.makeUnsafe("thread-11"),
            ThreadId.makeUnsafe("thread-10"),
          ],
        },
        {
          renderedThreadIds: [ThreadId.makeUnsafe("thread-8"), ThreadId.makeUnsafe("thread-6")],
        },
      ]),
    ).toEqual([
      ThreadId.makeUnsafe("thread-12"),
      ThreadId.makeUnsafe("thread-11"),
      ThreadId.makeUnsafe("thread-10"),
      ThreadId.makeUnsafe("thread-8"),
      ThreadId.makeUnsafe("thread-6"),
    ]);
  });

  it("skips threads from collapsed projects whose thread panels are not shown", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          shouldShowThreadPanel: false,
          renderedThreadIds: [
            ThreadId.makeUnsafe("thread-hidden-2"),
            ThreadId.makeUnsafe("thread-hidden-1"),
          ],
        },
        {
          shouldShowThreadPanel: true,
          renderedThreadIds: [ThreadId.makeUnsafe("thread-12"), ThreadId.makeUnsafe("thread-11")],
        },
      ]),
    ).toEqual([ThreadId.makeUnsafe("thread-12"), ThreadId.makeUnsafe("thread-11")]);
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});
describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not show plan ready after the proposed plan was implemented elsewhere", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the darker selected palette when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-primary/22");
    expect(className).toContain("hover:bg-primary/26");
    expect(className).toContain("dark:bg-primary/30");
    expect(className).not.toContain("bg-accent/85");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-primary/15");
    expect(className).toContain("hover:bg-primary/19");
    expect(className).toContain("dark:bg-primary/22");
    expect(className).not.toContain("hover:bg-accent");
  });

  it("keeps the accent palette for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-accent/85");
    expect(className).toContain("hover:bg-accent");
  });
});

describe("shouldDisableWorktreeTitleRegenerate", () => {
  const nowMs = Date.parse("2026-03-24T12:00:10.000Z");

  it("disables regenerate when the group has no title metadata yet", () => {
    expect(
      shouldDisableWorktreeTitleRegenerate({
        worktreeTitleStatus: "absent",
        worktreeTitleUpdatedAt: null,
        nowMs,
      }),
    ).toBe(true);
  });

  it("disables regenerate while pending is still fresh", () => {
    expect(
      shouldDisableWorktreeTitleRegenerate({
        worktreeTitleStatus: "pending",
        worktreeTitleUpdatedAt: "2026-03-24T12:00:05.500Z",
        nowMs,
      }),
    ).toBe(true);
  });

  it("enables regenerate when pending is stale", () => {
    expect(
      shouldDisableWorktreeTitleRegenerate({
        worktreeTitleStatus: "pending",
        worktreeTitleUpdatedAt: "2026-03-24T12:00:00.000Z",
        nowMs,
      }),
    ).toBe(false);
  });

  it("enables regenerate for ready and failed titles", () => {
    expect(
      shouldDisableWorktreeTitleRegenerate({
        worktreeTitleStatus: "ready",
        worktreeTitleUpdatedAt: "2026-03-24T12:00:09.000Z",
        nowMs,
      }),
    ).toBe(false);
    expect(
      shouldDisableWorktreeTitleRegenerate({
        worktreeTitleStatus: "failed",
        worktreeTitleUpdatedAt: "2026-03-24T12:00:09.000Z",
        nowMs,
      }),
    ).toBe(false);
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
      ThreadId.makeUnsafe("thread-5"),
      ThreadId.makeUnsafe("thread-6"),
      ThreadId.makeUnsafe("thread-8"),
    ]);
  });

  it("returns all threads when the list is expanded", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      isThreadListExpanded: true,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    forkOrigin: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("sortThreadsForSidebar", () => {
  it("sorts threads by the latest user message in recency mode", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "older",
              createdAt: "2026-03-09T10:01:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:01:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [
            {
              id: "message-2" as never,
              role: "user",
              text: "newer",
              createdAt: "2026-03-09T10:06:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:06:00.000Z",
            },
          ],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("falls back to thread timestamps when there is no user message", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:01:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "assistant",
              text: "assistant only",
              createdAt: "2026-03-09T10:02:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:02:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("falls back to id ordering when threads have no sortable timestamps", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("can sort threads by createdAt when configured", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
        }),
      ],
      "created_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });
});

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-oldest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other-project"),
          projectId: ProjectId.makeUnsafe("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-next"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      deletedThreadIds: new Set([
        ThreadId.makeUnsafe("thread-active"),
        ThreadId.makeUnsafe("thread-newest"),
      ]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-next"));
  });
});

describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-1"), name: "Older project" }),
      makeProject({ id: ProjectId.makeUnsafe("project-2"), name: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.makeUnsafe("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            createdAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:01:00.000Z",
          },
        ],
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        projectId: ProjectId.makeUnsafe("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            createdAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:05:00.000Z",
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Beta",
          createdAt: undefined,
          updatedAt: undefined,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Alpha",
          createdAt: undefined,
          updatedAt: undefined,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-1"),
      ProjectId.makeUnsafe("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-2"), name: "Second" }),
      makeProject({ id: ProjectId.makeUnsafe("project-1"), name: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});

describe("buildSidebarProjectTree", () => {
  it("nests managed worktree projects under their matching primary project", () => {
    const primaryProject = makeProject({
      id: ProjectId.makeUnsafe("project-primary"),
      name: "server",
      cwd: "/home/anoromi/code/stolen/t3code/apps/server",
    });
    const worktreeProject = makeProject({
      id: ProjectId.makeUnsafe("project-worktree"),
      name: "server",
      cwd: "/home/anoromi/.t3/worktrees/t3code/t3code-0f9f8314/apps/server",
    });
    const siblingProject = makeProject({
      id: ProjectId.makeUnsafe("project-sibling"),
      name: "web",
      cwd: "/home/anoromi/code/stolen/t3code/apps/web",
    });

    const tree = buildSidebarProjectTree([primaryProject, worktreeProject, siblingProject]);

    expect(tree.map((entry) => entry.project.id)).toEqual([
      ProjectId.makeUnsafe("project-primary"),
      ProjectId.makeUnsafe("project-sibling"),
    ]);
    expect(tree[0]?.childProjects).toHaveLength(1);
    expect(tree[0]?.childProjects[0]?.project.id).toBe(ProjectId.makeUnsafe("project-worktree"));
    expect(tree[0]?.childProjects[0]?.displayName).toBe("t3code-0f9f8314");
  });

  it("leaves worktree-like projects top-level when no matching parent exists", () => {
    const unmatchedWorktreeProject = makeProject({
      id: ProjectId.makeUnsafe("project-worktree"),
      name: "server",
      cwd: "/home/anoromi/.t3/worktrees/t3code/t3code-0f9f8314/apps/server",
    });
    const unrelatedProject = makeProject({
      id: ProjectId.makeUnsafe("project-unrelated"),
      name: "other",
      cwd: "/home/anoromi/code/stolen/t3code/apps/web",
    });

    const tree = buildSidebarProjectTree([unmatchedWorktreeProject, unrelatedProject]);

    expect(tree.map((entry) => entry.project.id)).toEqual([
      ProjectId.makeUnsafe("project-worktree"),
      ProjectId.makeUnsafe("project-unrelated"),
    ]);
    expect(tree[0]?.childProjects).toEqual([]);
    expect(tree[0]?.displayName).toBe("server");
  });

  it("keeps the grouped project at the earliest sorted position of its children", () => {
    const primaryProject = makeProject({
      id: ProjectId.makeUnsafe("project-primary"),
      name: "server",
      cwd: "/home/anoromi/code/stolen/t3code/apps/server",
    });
    const worktreeProject = makeProject({
      id: ProjectId.makeUnsafe("project-worktree"),
      name: "server",
      cwd: "/home/anoromi/.t3/worktrees/t3code/t3code-0f9f8314/apps/server",
    });
    const siblingProject = makeProject({
      id: ProjectId.makeUnsafe("project-sibling"),
      name: "web",
      cwd: "/home/anoromi/code/stolen/t3code/apps/web",
    });

    const tree = buildSidebarProjectTree([worktreeProject, siblingProject, primaryProject]);

    expect(tree.map((entry) => entry.project.id)).toEqual([
      ProjectId.makeUnsafe("project-primary"),
      ProjectId.makeUnsafe("project-sibling"),
    ]);
  });
});
