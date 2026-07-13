import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const { handleNewThreadSpy, navigateSpy } = vi.hoisted(() => ({
  handleNewThreadSpy: vi.fn(async () => undefined),
  navigateSpy: vi.fn(async () => undefined),
}));

vi.mock("@effect/atom-react", async () => {
  const actual = await vi.importActual<typeof import("@effect/atom-react")>("@effect/atom-react");
  return { ...actual, useAtomValue: vi.fn(() => ({})) };
});

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    useParams: () => ({}),
  };
});

vi.mock("../keybindings", () => ({
  resolveShortcutCommand: (event: KeyboardEvent) => {
    if (!event.ctrlKey && !event.metaKey) return null;
    if (event.key.toLowerCase() === "e") return "navigation.commandMenu";
    if (event.key.toLowerCase() === "k") return "commandPalette.toggle";
    return null;
  },
  shortcutLabelForCommand: () => null,
}));

const PROJECT = {
  id: "project-menu-test",
  environmentId: "environment-menu-test",
  title: "Navigation project",
  workspaceRoot: "/workspace/navigation-project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-10T10:00:00.000Z",
};
const THREAD = {
  id: "thread-menu-test",
  environmentId: "environment-menu-test",
  projectId: "project-menu-test",
  title: "Fix navigation hotkeys",
  modelSelection: { provider: "codex", model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/navigation",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  archivedAt: null,
  session: {
    status: "running",
    activeTurnId: "turn-menu-test",
  },
  latestUserMessageAt: "2026-07-11T10:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const STATUS_THREADS = [
  THREAD,
  {
    ...THREAD,
    id: "thread-menu-approval",
    title: "Approval status thread",
    hasPendingApprovals: true,
  },
  {
    ...THREAD,
    id: "thread-menu-input",
    title: "Input status thread",
    hasPendingUserInput: true,
  },
  {
    ...THREAD,
    id: "thread-menu-connecting",
    title: "Connecting status thread",
    session: { status: "starting", activeTurnId: null },
  },
];

vi.mock("../state/entities", () => ({
  useProject: () => null,
  useProjects: () => [PROJECT],
  useThread: () => null,
  useThreadShell: () => null,
  useThreadShells: () => STATUS_THREADS,
}));

vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  clearComposerDraftsEnvironment: () => undefined,
  useComposerDraftStore: (selector: (state: unknown) => unknown) =>
    selector({ draftThreadsByThreadKey: {} }),
}));
vi.mock("./Sidebar", () => ({ default: () => null }));
vi.mock("../connection/desktopLocal", () => ({
  desktopLocalBackendId: () => null,
  desktopLocalConnectionId: () => "desktop-local-test",
  isDesktopLocalConnectionTarget: () => false,
  readDesktopSecondaryBootstraps: () => [],
  readDesktopSecondaryBootstrapsResult: () => ({ bootstraps: [] }),
}));

vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => handleNewThreadSpy,
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: handleNewThreadSpy,
  }),
}));

vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return { useClientSettings: () => DEFAULT_CLIENT_SETTINGS };
});
vi.mock("../connection/useDesktopLocalBootstraps", () => ({
  useDesktopLocalBootstraps: () => [],
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ label: "Remote Test" }),
  useEnvironmentHttpBaseUrl: () => null,
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => "primary-environment",
  useRelayEnvironmentDiscovery: () => ({ data: [] }),
}));
vi.mock("../state/terminalSessions", () => ({
  useThreadRunningTerminalIds: () => ["terminal-status-test"],
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: false }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));
vi.mock("../terminalUiStateStore", () => ({
  selectThreadTerminalUiState: () => ({ terminalOpen: false }),
  useTerminalUiStateStore: (selector: (state: unknown) => unknown) =>
    selector({ terminalUiStateByThreadKey: {} }),
}));
vi.mock("../localApi", () => ({ readLocalApi: () => null }));

import { NavigationCommandMenuControl } from "./AppSidebarLayout";
import { CommandPalette } from "./CommandPalette";

describe("keyboard command menus", () => {
  afterEach(() => {
    handleNewThreadSpy.mockClear();
    navigateSpy.mockClear();
    document.body.innerHTML = "";
  });

  it("opens navigation with Ctrl+E and routes to the chosen thread", async () => {
    const screen = await render(
      <>
        <button type="button">Workspace</button>
        <NavigationCommandMenuControl />
      </>,
    );
    try {
      await page.getByRole("button", { name: "Workspace" }).click();
      await userEvent.keyboard("{Control>}e{/Control}");
      await expect
        .element(page.getByRole("dialog", { name: "Navigation command menu" }))
        .toBeInTheDocument();
      await expect.element(page.getByLabelText("Working")).toBeInTheDocument();
      await expect.element(page.getByLabelText("Pending Approval")).toBeInTheDocument();
      await expect.element(page.getByLabelText("Awaiting Input")).toBeInTheDocument();
      await expect.element(page.getByLabelText("Connecting")).toBeInTheDocument();
      await expect
        .element(page.getByLabelText("Terminal process running").first())
        .toBeInTheDocument();
      await expect.element(page.getByLabelText("Remote Test").first()).toBeInTheDocument();

      const input = page.getByRole("combobox");
      await input.fill("navigation hotkeys");
      await page.getByRole("option", { name: /Fix navigation hotkeys/ }).click();

      await vi.waitFor(() => {
        expect(navigateSpy).toHaveBeenCalledWith({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: "environment-menu-test",
            threadId: "thread-menu-test",
          },
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("opens navigation with Ctrl+E and starts the chosen project draft", async () => {
    const screen = await render(
      <>
        <button type="button">Workspace</button>
        <NavigationCommandMenuControl />
      </>,
    );
    try {
      await page.getByRole("button", { name: "Workspace" }).click();
      await userEvent.keyboard("{Control>}e{/Control}");
      const input = page.getByRole("combobox");
      await input.fill("Navigation project");
      await page.getByRole("option", { name: /^Navigation project/ }).click();

      await vi.waitFor(() => {
        expect(handleNewThreadSpy).toHaveBeenCalledWith({
          environmentId: "environment-menu-test",
          projectId: "project-menu-test",
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("opens the command palette with Ctrl+K and executes settings", async () => {
    const screen = await render(
      <CommandPalette>
        <div>Workspace</div>
      </CommandPalette>,
    );
    try {
      await page.getByText("Workspace", { exact: true }).click();
      await userEvent.keyboard("{Control>}k{/Control}");
      await expect
        .element(page.getByRole("dialog", { name: "Command palette" }))
        .toBeInTheDocument();
      await page.getByText("Open settings", { exact: true }).click();
      await vi.waitFor(() => {
        expect(navigateSpy).toHaveBeenCalledWith({ to: "/settings" });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not stack the command palette over open navigation", async () => {
    const screen = await render(
      <CommandPalette>
        <button type="button">Workspace</button>
        <NavigationCommandMenuControl />
      </CommandPalette>,
    );
    try {
      await page.getByRole("button", { name: "Workspace" }).click();
      await userEvent.keyboard("{Control>}e{/Control}");
      await expect
        .element(page.getByRole("dialog", { name: "Navigation command menu" }))
        .toBeInTheDocument();
      await page.getByRole("combobox").click();
      await userEvent.keyboard("{Control>}k{/Control}");
      await expect
        .element(page.getByRole("dialog", { name: "Command palette" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("dialog", { name: "Navigation command menu" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
