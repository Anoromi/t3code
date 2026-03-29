import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { Project, Thread } from "../types";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import {
  buildNavigationCommandResults,
  getProjectCommandActionLabel,
} from "./NavigationCommandMenu.logic";

function makeProject(overrides: Partial<Project> & Pick<Project, "id" | "name" | "cwd">): Project {
  return {
    id: overrides.id,
    name: overrides.name,
    cwd: overrides.cwd,
    defaultModelSelection:
      overrides.defaultModelSelection ??
      ({
        provider: "codex",
        model: "gpt-5-codex",
      } satisfies Project["defaultModelSelection"]),
    expanded: overrides.expanded ?? true,
    scripts: overrides.scripts ?? [],
    worktreeGroupTitles: overrides.worktreeGroupTitles ?? [],
  };
}

function makeThread(
  overrides: Partial<Thread> &
    Pick<Thread, "id" | "projectId" | "title" | "createdAt" | "updatedAt">,
): Thread {
  return {
    id: overrides.id,
    codexThreadId: overrides.codexThreadId ?? null,
    projectId: overrides.projectId,
    title: overrides.title,
    modelSelection:
      overrides.modelSelection ??
      ({
        provider: "codex",
        model: "gpt-5-codex",
      } satisfies Thread["modelSelection"]),
    runtimeMode: overrides.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: overrides.interactionMode ?? DEFAULT_INTERACTION_MODE,
    session: overrides.session ?? null,
    messages: overrides.messages ?? [],
    proposedPlans: overrides.proposedPlans ?? [],
    error: overrides.error ?? null,
    createdAt: overrides.createdAt,
    archivedAt: overrides.archivedAt ?? null,
    updatedAt: overrides.updatedAt,
    latestTurn: overrides.latestTurn ?? null,
    lastVisitedAt: overrides.lastVisitedAt,
    branch: overrides.branch ?? null,
    worktreePath: overrides.worktreePath ?? null,
    forkOrigin: overrides.forkOrigin ?? null,
    turnDiffSummaries: overrides.turnDiffSummaries ?? [],
    activities: overrides.activities ?? [],
  };
}

describe("buildNavigationCommandResults", () => {
  const projectAlpha = makeProject({
    id: ProjectId.makeUnsafe("project-alpha"),
    name: "Alpha App",
    cwd: "/repo/alpha-app",
  });
  const projectBeta = makeProject({
    id: ProjectId.makeUnsafe("project-beta"),
    name: "Beta Service",
    cwd: "/repo/beta-service",
  });
  const threadNewest = makeThread({
    id: ThreadId.makeUnsafe("thread-newest"),
    projectId: projectAlpha.id,
    title: "Fix auth redirect",
    createdAt: "2026-03-20T10:00:00.000Z",
    updatedAt: "2026-03-20T11:00:00.000Z",
    branch: "fix/auth-redirect",
  });
  const threadOlder = makeThread({
    id: ThreadId.makeUnsafe("thread-older"),
    projectId: projectBeta.id,
    title: "Investigate flaky queue",
    createdAt: "2026-03-19T10:00:00.000Z",
    updatedAt: "2026-03-19T11:00:00.000Z",
    worktreePath: "/repo/beta-service-worktree",
  });

  it("returns recent threads only when the query is empty", () => {
    const results = buildNavigationCommandResults({
      query: "",
      projects: [projectAlpha, projectBeta],
      threads: [threadOlder, threadNewest],
      draftProjectIds: new Set(),
    });

    expect(results.items.map((item) => item.id)).toEqual([threadNewest.id, threadOlder.id]);
  });

  it("intersperses project and thread matches by fuzzy score", () => {
    const projectServer = makeProject({
      id: ProjectId.makeUnsafe("project-server"),
      name: "server",
      cwd: "/repo/apps/server",
    });
    const threadServer = makeThread({
      id: ThreadId.makeUnsafe("thread-server"),
      projectId: projectServer.id,
      title: "Hello",
      createdAt: "2026-03-21T10:00:00.000Z",
      updatedAt: "2026-03-21T11:00:00.000Z",
    });
    const threadServerOlder = makeThread({
      id: ThreadId.makeUnsafe("thread-server-older"),
      projectId: projectServer.id,
      title: "testing?",
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T11:00:00.000Z",
    });

    const results = buildNavigationCommandResults({
      query: "server",
      projects: [projectServer],
      threads: [threadServerOlder, threadServer],
      draftProjectIds: new Set([projectServer.id]),
    });

    expect(results.items.map((item) => `${item.type}:${item.id}`)).toEqual([
      `project:${projectServer.id}`,
      `thread:${threadServer.id}`,
      `thread:${threadServerOlder.id}`,
    ]);
  });

  it("matches thread search using project metadata", () => {
    const results = buildNavigationCommandResults({
      query: "alpha",
      projects: [projectAlpha, projectBeta],
      threads: [threadOlder, threadNewest],
      draftProjectIds: new Set(),
    });

    expect(results.items).toHaveLength(2);
    expect(
      results.items.some((item) => item.type === "thread" && item.id === threadNewest.id),
    ).toBe(true);
    expect(
      results.items.some((item) => item.type === "project" && item.id === projectAlpha.id),
    ).toBe(true);
  });

  it("matches projects by name and cwd and exposes draft state", () => {
    const results = buildNavigationCommandResults({
      query: "beta service",
      projects: [projectAlpha, projectBeta],
      threads: [threadOlder, threadNewest],
      draftProjectIds: new Set([projectBeta.id]),
    });

    const projectResult = results.items.find((item) => item.type === "project");
    expect(projectResult).toMatchObject({
      id: projectBeta.id,
      hasDraft: true,
      latestThreadUpdatedAt: threadOlder.updatedAt,
    });
  });
});

describe("getProjectCommandActionLabel", () => {
  it("returns Open draft when the project already has a draft", () => {
    expect(getProjectCommandActionLabel(true)).toBe("Open draft");
  });

  it("returns New thread when the project has no draft", () => {
    expect(getProjectCommandActionLabel(false)).toBe("New thread");
  });
});
