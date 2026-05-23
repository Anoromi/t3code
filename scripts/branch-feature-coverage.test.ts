import { describe, expect, it } from "vitest";

const repoRootUrl = new URL("../", import.meta.url);

async function readRepoFile(relativePath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(relativePath, repoRootUrl), "utf8");
}

interface FeatureCoverage {
  readonly feature: string;
  readonly note: string;
  readonly noteMustMention: ReadonlyArray<string>;
  readonly tests: ReadonlyArray<{
    readonly file: string;
    readonly patterns: ReadonlyArray<RegExp>;
  }>;
}

const coverage: ReadonlyArray<FeatureCoverage> = [
  {
    feature: "repo guidance and release workflow",
    note: "commits/repo: add local agent, design, and release workflow guidance.md",
    noteMustMention: ["rebase conflict-resolution skill", "release workflow"],
    tests: [
      {
        file: "scripts/workflow-config.test.ts",
        patterns: [/desktop artifact publishing/, /dist:desktop:artifact/],
      },
      {
        file: "scripts/repo-config.test.ts",
        patterns: [/repo configuration and branch metadata/],
      },
    ],
  },
  {
    feature: "Nix packaging and local desktop launch",
    note: "commits/desktop: add Nix packaging and local launch support.md",
    noteMustMention: ["Nix packaging", "Preserves launch environment"],
    tests: [
      {
        file: "scripts/local-desktop-launch.test.ts",
        patterns: [/runLocalDesktopLaunch/, /captured env plus the active nix runtime keys/],
      },
      {
        file: "apps/desktop/scripts/runtime-args.test.mjs",
        patterns: [/explicit Wayland ozone args/, /Electron and NixOS Wayland hints/],
      },
      {
        file: "scripts/workflow-config.test.ts",
        patterns: [/desktop Wayland runtime env through Turbo/],
      },
    ],
  },
  {
    feature: "server fork/runtime/projection compatibility",
    note: "commits/server: rework Codex runtime, projections, and persistence repair.md",
    noteMustMention: ["forkSource", "legacy decode"],
    tests: [
      {
        file: "packages/contracts/src/orchestration.test.ts",
        patterns: [/forkSourceThreadId/, /sourceThreadId/],
      },
      {
        file: "packages/contracts/src/provider.test.ts",
        patterns: [/forkSourceThreadId/, /sourceThreadId/],
      },
      {
        file: "apps/server/src/orchestration/projector.test.ts",
        patterns: [/forkSourceThreadId/, /legacy/],
      },
    ],
  },
  {
    feature: "desktop Hyprland, Hyprnav, Corkdiff, and worktree terminals",
    note: "commits/desktop: wire Hyprland, Hyprnav, Corkdiff, and worktree terminals.md",
    noteMustMention: ["Hyprland", "Corkdiff", "worktree terminals"],
    tests: [
      {
        file: "scripts/hypr-worktree.test.ts",
        patterns: [/hypr-worktree/, /spawn switches first/],
      },
      {
        file: "scripts/ghostty-worktree.test.ts",
        patterns: [/ghostty-worktree/, /launches Ghostty with the managed class/],
      },
      {
        file: "apps/desktop/src/worktreeTerminal.test.ts",
        patterns: [/WorktreeTerminalLauncher/, /spawns ghostty-worktree/],
      },
      {
        file: "apps/web/src/components/ChatView.browser.tsx",
        patterns: [/desktop Corkdiff and worktree terminal shortcuts to the bridge/],
      },
    ],
  },
  {
    feature: "web chat commands, worktree, model, terminal UX",
    note: "commits/web: add chat command, model, worktree, and terminal UX.md",
    noteMustMention: ["/worktree", "thread command bar", "terminal drawer"],
    tests: [
      {
        file: "apps/web/src/components/ChatView.browser.tsx",
        patterns: [
          /recovered branch, worktree, fast, and reasoning slash commands/,
          /selects a named worktree from the slash-command menu/,
          /recovered fork slash command with canonical source naming/,
          /opens the restored thread command bar from its shortcut/,
        ],
      },
      {
        file: "apps/web/src/components/chat/ThreadCommandBar.logic.test.ts",
        patterns: [/ThreadCommandBar.logic/, /filters groups in command bar order/],
      },
      {
        file: "apps/web/src/lib/chatGlobalShortcuts.test.ts",
        patterns: [/chatGlobalShortcuts/, /terminal\.worktree\.open/],
      },
    ],
  },
  {
    feature: "desktop smoke and migrated browser flows",
    note: "commits/test: configure desktop smoke and browser flow coverage.md",
    noteMustMention: ["one Electron smoke test", "browser coverage"],
    tests: [
      {
        file: "apps/desktop/e2e/desktopSmoke.spec.ts",
        patterns: [/sends a message in a new thread/, /desktopBridge/],
      },
      {
        file: "apps/web/src/components/ChatView.browser.tsx",
        patterns: [/worktree/, /terminal/],
      },
    ],
  },
  {
    feature: "local development process management",
    note: "commits/scripts: improve local development process management.md",
    noteMustMention: ["cleanup", "readiness"],
    tests: [
      {
        file: "scripts/kill-dev-instances.test.ts",
        patterns: [/kill-dev-instances/, /selects dev roots/],
      },
      {
        file: "apps/web/src/devBackendProxy.test.ts",
        patterns: [/backend proxy/, /readiness/],
      },
    ],
  },
  {
    feature: "read-aloud interaction",
    note: "commits/web: improve read-aloud interaction.md",
    noteMustMention: ["read-aloud controls", "highlighting"],
    tests: [
      {
        file: "apps/web/src/components/ChatView.browser.tsx",
        patterns: [/renders read-aloud controls through the thread provider/],
      },
      {
        file: "apps/web/src/components/readAloud/ThreadReadAloudProvider.test.ts",
        patterns: [/Read from here/, /read-aloud context menu/, /code block read-aloud units/],
      },
      {
        file: "apps/server/src/readAloud/localAiToolsSession.test.ts",
        patterns: [/LocalAiToolsSessionManager/, /sends valid synthesize JSON/],
      },
    ],
  },
  {
    feature: "agent-authored markdown highlights",
    note: "commits/web: add agent-authored markdown highlights.md",
    noteMustMention: ["semantic highlight", "unsafe markup"],
    tests: [
      {
        file: "apps/web/src/components/ChatMarkdown.browser.tsx",
        patterns: [/semantic highlight/, /script/i],
      },
    ],
  },
];

describe("branch feature coverage", () => {
  for (const item of coverage) {
    it(`keeps regression coverage for ${item.feature}`, async () => {
      const note = await readRepoFile(item.note);
      for (const phrase of item.noteMustMention) {
        expect(note).toContain(phrase);
      }

      for (const testFile of item.tests) {
        const contents = await readRepoFile(testFile.file);
        for (const pattern of testFile.patterns) {
          expect(contents).toMatch(pattern);
        }
      }
    });
  }
});
