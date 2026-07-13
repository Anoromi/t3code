import { describe, expect, it } from "vite-plus/test";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";

import { buildNavigationCommandResults } from "./NavigationCommandMenu.logic";

const project = {
  id: "project-nav",
  environmentId: "environment-nav",
  title: "Navigation project",
  workspaceRoot: "/workspace/navigation",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
} as EnvironmentProject;

const thread = {
  id: "thread-nav",
  environmentId: project.environmentId,
  projectId: project.id,
  title: "Fix command hotkeys",
  branch: "feature/hotkeys",
  worktreePath: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  latestUserMessageAt: null,
  archivedAt: null,
} as EnvironmentThreadShell;

describe("buildNavigationCommandResults", () => {
  it("shows recent threads when the query is empty", () => {
    expect(
      buildNavigationCommandResults({ query: "", projects: [project], threads: [thread] }),
    ).toMatchObject([{ type: "thread", title: "Fix command hotkeys", thread }]);
  });

  it("searches threads and projects and preserves scoped draft identity", () => {
    const draftProjectKeys = new Set([
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
    ]);
    const results = buildNavigationCommandResults({
      query: "navigation",
      projects: [project],
      threads: [thread],
      draftProjectKeys,
    });

    expect(results).toContainEqual(
      expect.objectContaining({
        type: "project",
        title: "Navigation project",
        hasDraft: true,
        ref: { environmentId: "environment-nav", projectId: "project-nav" },
      }),
    );
  });

  it("matches thread branch names", () => {
    expect(
      buildNavigationCommandResults({ query: "feature/", projects: [project], threads: [thread] }),
    ).toMatchObject([{ type: "thread", title: "Fix command hotkeys" }]);
  });
});
