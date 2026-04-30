import { describe, expect, it } from "vitest";

import type { ProjectHyprnavSettings } from "@t3tools/contracts";

import {
  areProjectHyprnavActionsDisabled,
  buildProjectHyprnavResetDraft,
  resolveProjectHyprnavNextSaveTarget,
  resolveProjectHyprnavNextOverride,
} from "./ProjectHyprnavSettingsPanel";

describe("ProjectHyprnavSettingsPanel logic", () => {
  it("builds reset drafts from the current global defaults rather than built-in bindings", () => {
    const currentGlobalDefaults: ProjectHyprnavSettings = {
      bindings: [
        {
          id: "custom-thread-default",
          slot: 7,
          scope: "thread",
          workspace: { mode: "managed" },
          action: "nothing",
        },
      ],
    };

    expect(buildProjectHyprnavResetDraft(currentGlobalDefaults)).toEqual([
      {
        id: "custom-thread-default",
        slot: "7",
        scope: "thread",
        workspaceMode: "managed",
        workspaceId: "",
        name: "",
        action: "nothing",
        command: "",
      },
    ]);
  });

  it("keeps project hyprnav actions disabled until client settings hydrate", () => {
    expect(
      areProjectHyprnavActionsDisabled({
        busy: false,
        clientSettingsHydrated: false,
      }),
    ).toBe(true);

    expect(
      areProjectHyprnavActionsDisabled({
        busy: true,
        clientSettingsHydrated: true,
      }),
    ).toBe(true);

    expect(
      areProjectHyprnavActionsDisabled({
        busy: false,
        clientSettingsHydrated: true,
      }),
    ).toBe(false);
  });

  it("saves inherited null when the parsed project settings match the current global defaults", () => {
    const currentGlobalDefaults: ProjectHyprnavSettings = {
      bindings: [
        {
          id: "custom-thread-default",
          slot: 7,
          scope: "thread",
          workspace: { mode: "managed" },
          action: "nothing",
        },
      ],
    };

    expect(
      resolveProjectHyprnavNextOverride({
        parsedSettings: currentGlobalDefaults,
        defaultProjectHyprnavSettings: currentGlobalDefaults,
        forceInherited: false,
      }),
    ).toBeNull();
  });

  it("keeps an explicit override when the parsed project settings differ from the current global defaults", () => {
    const currentGlobalDefaults: ProjectHyprnavSettings = {
      bindings: [
        {
          id: "custom-thread-default",
          slot: 7,
          scope: "thread",
          workspace: { mode: "managed" },
          action: "nothing",
        },
      ],
    };
    const explicitOverride: ProjectHyprnavSettings = {
      bindings: [
        {
          id: "worktree-terminal",
          slot: 1,
          scope: "worktree",
          workspace: { mode: "managed" },
          action: "worktree-terminal",
        },
      ],
    };

    expect(
      resolveProjectHyprnavNextOverride({
        parsedSettings: explicitOverride,
        defaultProjectHyprnavSettings: currentGlobalDefaults,
        forceInherited: false,
      }),
    ).toEqual(explicitOverride);
  });

  it("saves inherited null against the exact reset snapshot even if current defaults later differ", () => {
    const inheritedSnapshot: ProjectHyprnavSettings = {
      bindings: [
        {
          id: "custom-thread-default",
          slot: 7,
          scope: "thread",
          workspace: { mode: "managed" },
          name: "Terminal",
          action: "nothing",
        },
      ],
    };
    const laterObservedDefaults: ProjectHyprnavSettings = {
      bindings: [
        {
          id: "worktree-terminal",
          slot: 1,
          scope: "worktree",
          workspace: { mode: "managed" },
          action: "worktree-terminal",
        },
      ],
    };

    expect(
      resolveProjectHyprnavNextSaveTarget({
        parsedSettings: inheritedSnapshot,
        defaultProjectHyprnavSettings: laterObservedDefaults,
        pendingInheritedSettings: inheritedSnapshot,
      }),
    ).toEqual({
      nextOverride: null,
      nextSettings: inheritedSnapshot,
    });
  });
});
