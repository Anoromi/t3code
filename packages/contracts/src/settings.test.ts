import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { DEFAULT_PROJECT_HYPRNAV_SETTINGS } from "./orchestration.ts";
import { ClientSettingsSchema } from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);

describe("ClientSettingsSchema", () => {
  it("defaults global project Hyprnav settings", () => {
    const parsed = decodeClientSettings({});

    expect(parsed.defaultProjectHyprnavSettings).toEqual(DEFAULT_PROJECT_HYPRNAV_SETTINGS);
  });

  it("decodes explicit global project Hyprnav settings", () => {
    const parsed = decodeClientSettings({
      defaultProjectHyprnavSettings: {
        bindings: [
          {
            id: "custom",
            slot: 3,
            scope: "project",
            workspace: { mode: "absolute", workspaceId: 11 },
            name: "API",
            action: "shell-command",
            command: "tmux",
          },
        ],
      },
    });

    expect(parsed.defaultProjectHyprnavSettings).toEqual({
      bindings: [
        {
          id: "custom",
          slot: 3,
          scope: "project",
          workspace: { mode: "absolute", workspaceId: 11 },
          name: "API",
          action: "shell-command",
          command: "tmux",
        },
      ],
    });
  });
});
