import { describe, expect, it } from "vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { Project, Thread } from "../types";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import {
  buildNavigationCommandResults,
  getProjectCommandActionLabel,
} from "./NavigationCommandMenu.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-navigation-test");

function makeProject(overrides: Partial<Project> & Pick<Project, "id" | "name" | "cwd">): Project {
  return {
    environmentId: overrides.environmentId ?? ENVIRONMENT_ID,
    id: overrides.id,
    name: overrides.name,
    cwd: overrides.cwd,
    defaultModelSelection:
      overrides.defaultModelSelection ??
      ({
        provider: "codex",
        model: "gpt-5-codex",
      } satisfies Project["defaultModelSelection"]),
    scripts: overrides.scripts ?? [],
    worktreeGroupTitles: overrides.worktreeGroupTitles ?? [],
  };
}

function makeThread(
  overrides: Partial<Thread> &
    Pick<Thread, "id" | "projectId" | "title" | "createdAt" | "updatedAt">,
): Thread {
  return {
    environmentId: overrides.environmentId ?? ENVIRONMENT_ID,
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
    branch: overrides.branch ?? null,
    worktreePath: overrides.worktreePath ?? null,
    forkOrigin: overrides.forkOrigin ?? null,
    turnDiffSummaries: overrides.turnDiffSummaries ?? [],
    activities: overrides.activities ?? [],
  };
}

describe("buildNavigationCommandResults", () => {
  const projectAlpha = makeProject({
    id: ProjectId.make("project-alpha"),
    name: "Alpha App",
    cwd: "/repo/alpha-app",
  });
  const projectBeta = makeProject({
    id: ProjectId.make("project-beta"),
    name: "Beta Service",
    cwd: "/repo/beta-service",
  });
  const threadNewest = makeThread({
    id: ThreadId.make("thread-newest"),
    projectId: projectAlpha.id,
    title: "Fix auth redirect",
    createdAt: "2026-03-20T10:00:00.000Z",
    updatedAt: "2026-03-20T11:00:00.000Z",
    branch: "fix/auth-redirect",
    messages: [
      {
        id: "message-newest-user" as Thread["messages"][number]["id"],
        role: "user",
        text: "Please fix auth redirect",
        createdAt: "2026-03-20T10:55:00.000Z",
        streaming: false,
      },
    ],
  });
  const threadOlder = makeThread({
    id: ThreadId.make("thread-older"),
    projectId: projectBeta.id,
    title: "Investigate flaky queue",
    createdAt: "2026-03-19T10:00:00.000Z",
    updatedAt: "2026-03-19T11:00:00.000Z",
    worktreePath: "/repo/beta-service-worktree",
    messages: [
      {
        id: "message-older-user" as Thread["messages"][number]["id"],
        role: "user",
        text: "Investigate the flaky queue",
        createdAt: "2026-03-19T10:30:00.000Z",
        streaming: false,
      },
    ],
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

  it("sorts recent threads by last user message instead of later assistant activity", () => {
    const threadWithLaterAssistantUpdate = makeThread({
      id: ThreadId.make("thread-later-assistant"),
      projectId: projectAlpha.id,
      title: "Long running task",
      createdAt: "2026-03-21T09:00:00.000Z",
      updatedAt: "2026-03-21T12:00:00.000Z",
      messages: [
        {
          id: "message-later-assistant-user" as Thread["messages"][number]["id"],
          role: "user",
          text: "Start the task",
          createdAt: "2026-03-21T09:05:00.000Z",
          streaming: false,
        },
        {
          id: "message-later-assistant" as Thread["messages"][number]["id"],
          role: "assistant",
          text: "Still working",
          createdAt: "2026-03-21T11:59:00.000Z",
          streaming: false,
        },
      ],
    });
    const threadWithNewerUserMessage = makeThread({
      id: ThreadId.make("thread-newer-user"),
      projectId: projectAlpha.id,
      title: "Fresh request",
      createdAt: "2026-03-21T08:00:00.000Z",
      updatedAt: "2026-03-21T10:00:00.000Z",
      messages: [
        {
          id: "message-newer-user" as Thread["messages"][number]["id"],
          role: "user",
          text: "Here is the latest request",
          createdAt: "2026-03-21T11:00:00.000Z",
          streaming: false,
        },
      ],
    });

    const results = buildNavigationCommandResults({
      query: "",
      projects: [projectAlpha],
      threads: [threadWithLaterAssistantUpdate, threadWithNewerUserMessage],
      draftProjectIds: new Set(),
    });

    expect(results.items.map((item) => item.id)).toEqual([
      threadWithNewerUserMessage.id,
      threadWithLaterAssistantUpdate.id,
    ]);
  });

  it("intersperses project and thread matches by fuzzy score", () => {
    const projectServer = makeProject({
      id: ProjectId.make("project-server"),
      name: "server",
      cwd: "/repo/apps/server",
    });
    const threadServer = makeThread({
      id: ThreadId.make("thread-server"),
      projectId: projectServer.id,
      title: "Hello",
      createdAt: "2026-03-21T10:00:00.000Z",
      updatedAt: "2026-03-21T11:00:00.000Z",
    });
    const threadServerOlder = makeThread({
      id: ThreadId.make("thread-server-older"),
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
      latestThreadRecencyAt: "2026-03-19T10:30:00.000Z",
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
