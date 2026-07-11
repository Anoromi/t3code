import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId, type ProjectHyprnavSettings } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildHyprnavPublicationRequests,
  hyprnavDraftFromSettings,
  parseHyprnavDraft,
  publishSettingsChange,
  resolveProjectHyprnavNextOverride,
} from "./ProjectHyprnavSettingsPanel";

const SETTINGS: ProjectHyprnavSettings = {
  bindings: [
    {
      id: "terminal",
      slot: 1,
      scope: "worktree",
      workspace: { mode: "managed" },
      name: "Terminal",
      action: "worktree-terminal",
    },
    {
      id: "command",
      slot: 4,
      scope: "thread",
      workspace: { mode: "absolute", workspaceId: 7 },
      action: "shell-command",
      command: "notify-send ready",
    },
  ],
};

describe("ProjectHyprnavSettingsPanel logic", () => {
  it("round trips every editable binding field", () => {
    const draft = hyprnavDraftFromSettings(SETTINGS);
    expect(draft[1]).toMatchObject({
      slot: "4",
      scope: "thread",
      workspaceMode: "absolute",
      workspaceId: "7",
      action: "shell-command",
      command: "notify-send ready",
    });
    expect(parseHyprnavDraft(draft)).toEqual({ settings: SETTINGS, message: null });
  });

  it("rejects duplicate slots only within the same scope", () => {
    const draft = hyprnavDraftFromSettings(SETTINGS);
    expect(
      parseHyprnavDraft([...draft, { ...draft[0]!, id: "duplicate", action: "nothing" }]).message,
    ).toBe("Each scope can use a slot only once.");

    expect(
      parseHyprnavDraft([
        ...draft,
        { ...draft[0]!, id: "project-slot", scope: "project", action: "nothing" },
      ]).message,
    ).toBeNull();
  });

  it("requires valid absolute workspaces and shell commands", () => {
    const [terminal, command] = hyprnavDraftFromSettings(SETTINGS);
    expect(
      parseHyprnavDraft([{ ...terminal!, workspaceMode: "absolute", workspaceId: "0" }]).message,
    ).toContain("positive workspace");
    expect(parseHyprnavDraft([{ ...command!, command: " " }]).message).toContain("need a command");
  });

  it("rejects binding names longer than the persisted contract allows", () => {
    const [binding] = hyprnavDraftFromSettings(SETTINGS);
    expect(parseHyprnavDraft([{ ...binding!, name: "x".repeat(256) }]).message).toBe(
      "Binding names must be 255 characters or fewer.",
    );
    expect(parseHyprnavDraft([{ ...binding!, name: "x".repeat(255) }]).message).toBeNull();
  });

  it("persists inherited null when a project matches the global defaults", () => {
    expect(
      resolveProjectHyprnavNextOverride({
        parsedSettings: SETTINGS,
        defaultProjectHyprnavSettings: SETTINGS,
        forceInherited: false,
      }),
    ).toBeNull();
    expect(
      resolveProjectHyprnavNextOverride({
        parsedSettings: { bindings: [] },
        defaultProjectHyprnavSettings: SETTINGS,
        forceInherited: false,
      }),
    ).toEqual({ bindings: [] });
  });

  it("publishes removed slots and cleared names after a durable settings change", () => {
    const environmentId = EnvironmentId.make("primary");
    const projectId = ProjectId.make("project-1");
    const previous: ProjectHyprnavSettings = {
      bindings: [
        {
          id: "removed",
          slot: 1,
          scope: "project",
          workspace: { mode: "managed" },
          action: "nothing",
        },
        {
          id: "renamed",
          slot: 2,
          scope: "worktree",
          workspace: { mode: "managed" },
          name: "Old name",
          action: "nothing",
        },
      ],
    };
    const next: ProjectHyprnavSettings = {
      bindings: [
        {
          id: "renamed",
          slot: 2,
          scope: "worktree",
          workspace: { mode: "managed" },
          action: "nothing",
        },
      ],
    };
    const requests = buildHyprnavPublicationRequests({
      localEnvironmentId: environmentId,
      projects: [
        {
          id: projectId,
          environmentId,
          title: "Project",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          hyprnav: previous,
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z",
          nextHyprnav: next,
        },
      ],
      threadShells: [],
      previousSettingsByProjectKey: new Map([
        [scopedProjectKey(scopeProjectRef(environmentId, projectId)), previous],
      ]),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      projectRoot: "/repo",
      clearBindings: [{ scope: "project", slot: 1 }],
      clearNames: [{ scope: "worktree", slot: 2 }],
    });
  });

  it("reports publication exceptions as saved but not applied", async () => {
    const environmentId = EnvironmentId.make("primary");
    const projectId = ProjectId.make("project-1");
    await expect(
      publishSettingsChange({
        localEnvironmentId: environmentId,
        projects: [
          {
            id: projectId,
            environmentId,
            title: "Project",
            workspaceRoot: "/repo",
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [],
            hyprnav: SETTINGS,
            createdAt: "2026-07-11T00:00:00.000Z",
            updatedAt: "2026-07-11T00:00:00.000Z",
            nextHyprnav: SETTINGS,
          },
        ],
        threadShells: [],
        previousSettingsByProjectKey: new Map([
          [scopedProjectKey(scopeProjectRef(environmentId, projectId)), SETTINGS],
        ]),
        availableEditors: [],
        publish: async () => {
          throw new Error("ticket issuance failed");
        },
      }),
    ).resolves.toBe("Saved, but Hyprnav was not applied. ticket issuance failed");
  });
});
