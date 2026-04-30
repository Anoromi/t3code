import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type EnvironmentApi,
  type ExecutionEnvironmentDescriptor,
  type LocalApi,
  type ProjectHyprnavSettings,
  ProjectId,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { __resetLocalApiForTests } from "../../localApi";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useStore } from "../../store";
import {
  HyprnavDefaultsSettingsPanel,
  ProjectHyprnavSettingsPanel,
} from "./ProjectHyprnavSettingsPanel";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const NOW_ISO = "2026-04-28T12:00:00.000Z";

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: ENVIRONMENT_ID,
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function createPrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor {
  return {
    environmentId: ENVIRONMENT_ID,
    label: "Local environment",
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
    },
  };
}

function HyprnavSettingsHarness() {
  const [screen, setScreen] = useState<"defaults" | "project">("defaults");

  return (
    <div>
      <button type="button" onClick={() => setScreen("defaults")}>
        Show defaults
      </button>
      <button type="button" onClick={() => setScreen("project")}>
        Show project
      </button>
      {screen === "defaults" ? (
        <HyprnavDefaultsSettingsPanel />
      ) : (
        <ProjectHyprnavSettingsPanel environmentId={ENVIRONMENT_ID} projectId={PROJECT_ID} />
      )}
    </div>
  );
}

describe("ProjectHyprnavSettingsPanel browser", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    __resetEnvironmentApiOverridesForTests();
    localStorage.clear();
    document.body.innerHTML = "";
    writePrimaryEnvironmentDescriptor(createPrimaryEnvironmentDescriptor());
    useStore.setState({
      activeEnvironmentId: ENVIRONMENT_ID,
      environmentStateById: {
        [ENVIRONMENT_ID]: {
          projectIds: [PROJECT_ID],
          projectById: {
            [PROJECT_ID]: {
              id: PROJECT_ID,
              environmentId: ENVIRONMENT_ID,
              name: "Project",
              cwd: "/repo/project",
              repositoryIdentity: null,
              defaultModelSelection: null,
              scripts: [],
              hyprnav: {
                bindings: [
                  {
                    id: "project-custom",
                    slot: 5,
                    scope: "worktree",
                    workspace: { mode: "managed" },
                    action: "nothing",
                  },
                ],
              },
              createdAt: NOW_ISO,
              updatedAt: NOW_ISO,
              worktreeGroupTitles: [],
            },
          },
          threadIds: [],
          threadIdsByProjectId: {},
          threadShellById: {},
          threadSessionById: {},
          threadTurnStateById: {},
          messageIdsByThreadId: {},
          messageByThreadId: {},
          activityIdsByThreadId: {},
          activityByThreadId: {},
          proposedPlanIdsByThreadId: {},
          proposedPlanByThreadId: {},
          turnDiffIdsByThreadId: {},
          turnDiffSummaryByThreadId: {},
          sidebarThreadSummaryById: {},
          bootstrapComplete: true,
        },
      },
    });
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    __resetEnvironmentApiOverridesForTests();
    Reflect.deleteProperty(window, "nativeApi");
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
    resetServerStateForTests();
    await __resetLocalApiForTests();
  });

  it("saves a project reset as inherited null after client defaults hydrate", async () => {
    const persistedDefaults: ProjectHyprnavSettings = {
      bindings: [
        {
          id: "global-custom-default",
          slot: 7,
          scope: "thread",
          workspace: { mode: "managed" },
          action: "nothing",
          name: "Hydrated default",
        },
      ],
    };
    const clientSettingsHydration = createDeferredPromise<typeof DEFAULT_CLIENT_SETTINGS>();
    const dispatchCommandSpy = vi.fn<EnvironmentApi["orchestration"]["dispatchCommand"]>();
    dispatchCommandSpy.mockResolvedValue({ sequence: 1 });
    const setClientSettingsSpy = vi.fn<LocalApi["persistence"]["setClientSettings"]>();
    setClientSettingsSpy.mockResolvedValue(undefined);

    setServerConfigSnapshot(createBaseServerConfig());
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      terminal: {} as EnvironmentApi["terminal"],
      projects: {} as EnvironmentApi["projects"],
      filesystem: {} as EnvironmentApi["filesystem"],
      git: {} as EnvironmentApi["git"],
      orchestration: {
        dispatchCommand: dispatchCommandSpy,
        getTurnDiff: vi.fn() as EnvironmentApi["orchestration"]["getTurnDiff"],
        getFullThreadDiff: vi.fn() as EnvironmentApi["orchestration"]["getFullThreadDiff"],
        subscribeShell: vi.fn(
          () => () => undefined,
        ) as EnvironmentApi["orchestration"]["subscribeShell"],
        subscribeThread: vi.fn(
          () => () => undefined,
        ) as EnvironmentApi["orchestration"]["subscribeThread"],
      },
    });

    window.nativeApi = {
      dialogs: {
        pickFolder: vi.fn().mockResolvedValue(null),
        confirm: vi.fn().mockResolvedValue(true),
      },
      shell: {
        openInEditor: vi.fn().mockResolvedValue(undefined),
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
      contextMenu: {
        show: vi.fn().mockResolvedValue(null),
      },
      persistence: {
        getClientSettings: vi.fn().mockImplementation(() => clientSettingsHydration.promise),
        setClientSettings: setClientSettingsSpy,
        getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
        setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
        getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
        setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
        removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        getConfig: vi.fn().mockResolvedValue(createBaseServerConfig()),
        refreshProviders: vi.fn().mockResolvedValue({ providers: [] }),
        upsertKeybinding: vi.fn(),
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
        updateSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
      },
    } satisfies LocalApi;

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProjectHyprnavSettingsPanel environmentId={ENVIRONMENT_ID} projectId={PROJECT_ID} />
      </AppAtomRegistryProvider>,
    );

    const resetButton = page.getByRole("button", { name: "Reset to default" });
    const saveButton = page.getByRole("button", { name: "Save and apply" });

    await expect
      .element(page.getByRole("heading", { name: "Project", exact: true }))
      .toBeInTheDocument();
    await expect.element(resetButton).toBeDisabled();
    await expect.element(saveButton).toBeDisabled();

    clientSettingsHydration.resolve({
      ...DEFAULT_CLIENT_SETTINGS,
      defaultProjectHyprnavSettings: persistedDefaults,
    });

    await expect.element(resetButton).toBeEnabled();
    await expect.element(saveButton).toBeEnabled();

    await resetButton.click();
    await expect.element(page.getByRole("textbox").first()).toHaveValue("7");

    await saveButton.click();

    await expect.poll(() => dispatchCommandSpy.mock.calls.length).toBe(1);
    expect(dispatchCommandSpy.mock.calls[0]?.[0]).toMatchObject({
      type: "project.meta.update",
      projectId: PROJECT_ID,
      hyprnav: null,
    });

    expect(
      useStore.getState().environmentStateById[ENVIRONMENT_ID]?.projectById[PROJECT_ID]?.hyprnav,
    ).toBeNull();
    expect(setClientSettingsSpy).toHaveBeenCalled();
    expect(setClientSettingsSpy.mock.calls.at(-1)?.[0].defaultProjectHyprnavSettings).toEqual(
      persistedDefaults,
    );
  });

  it("resets a saved project override back to the saved custom defaults instead of built-in 1/2/8", async () => {
    let persistedClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
    };
    const dispatchCommandSpy = vi.fn<EnvironmentApi["orchestration"]["dispatchCommand"]>();
    dispatchCommandSpy.mockResolvedValue({ sequence: 1 });
    const setClientSettingsSpy = vi.fn<LocalApi["persistence"]["setClientSettings"]>();
    setClientSettingsSpy.mockImplementation(async (settings) => {
      persistedClientSettings = settings;
    });

    setServerConfigSnapshot(createBaseServerConfig());
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      terminal: {} as EnvironmentApi["terminal"],
      projects: {} as EnvironmentApi["projects"],
      filesystem: {} as EnvironmentApi["filesystem"],
      git: {} as EnvironmentApi["git"],
      orchestration: {
        dispatchCommand: dispatchCommandSpy,
        getTurnDiff: vi.fn() as EnvironmentApi["orchestration"]["getTurnDiff"],
        getFullThreadDiff: vi.fn() as EnvironmentApi["orchestration"]["getFullThreadDiff"],
        subscribeShell: vi.fn(
          () => () => undefined,
        ) as EnvironmentApi["orchestration"]["subscribeShell"],
        subscribeThread: vi.fn(
          () => () => undefined,
        ) as EnvironmentApi["orchestration"]["subscribeThread"],
      },
    });

    window.nativeApi = {
      dialogs: {
        pickFolder: vi.fn().mockResolvedValue(null),
        confirm: vi.fn().mockResolvedValue(true),
      },
      shell: {
        openInEditor: vi.fn().mockResolvedValue(undefined),
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
      contextMenu: {
        show: vi.fn().mockResolvedValue(null),
      },
      persistence: {
        getClientSettings: vi.fn().mockImplementation(async () => persistedClientSettings),
        setClientSettings: setClientSettingsSpy,
        getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
        setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
        getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
        setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
        removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        getConfig: vi.fn().mockResolvedValue(createBaseServerConfig()),
        refreshProviders: vi.fn().mockResolvedValue({ providers: [] }),
        upsertKeybinding: vi.fn(),
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
        updateSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
      },
    } satisfies LocalApi;

    mounted = await render(
      <AppAtomRegistryProvider>
        <HyprnavDefaultsSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const globalSlotInput = page.getByRole("textbox").first();
    await expect.element(globalSlotInput).toHaveValue("1");
    await globalSlotInput.fill("9");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expect.poll(() => setClientSettingsSpy.mock.calls.length).toBeGreaterThan(0);
    expect(persistedClientSettings.defaultProjectHyprnavSettings.bindings[0]?.slot).toBe(9);

    const teardown = mounted.cleanup ?? mounted.unmount;
    await teardown?.call(mounted).catch(() => {});
    mounted = null;
    document.body.innerHTML = "";

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProjectHyprnavSettingsPanel environmentId={ENVIRONMENT_ID} projectId={PROJECT_ID} />
      </AppAtomRegistryProvider>,
    );

    const projectSlotInput = page.getByRole("textbox").first();
    await expect.element(projectSlotInput).toHaveValue("5");
    await projectSlotInput.fill("6");
    await page.getByRole("button", { name: "Save and apply" }).click();
    await expect.poll(() => dispatchCommandSpy.mock.calls.length).toBe(1);
    expect(dispatchCommandSpy.mock.calls[0]?.[0]).toMatchObject({
      type: "project.meta.update",
      projectId: PROJECT_ID,
      hyprnav: {
        bindings: [{ slot: 6 }],
      },
    });

    await page.getByRole("button", { name: "Reset to default" }).click();
    await expect.element(projectSlotInput).toHaveValue("9");
  });

  it("keeps custom defaults when switching from defaults to project in the same mounted tree", async () => {
    let persistedClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
    };
    const dispatchCommandSpy = vi.fn<EnvironmentApi["orchestration"]["dispatchCommand"]>();
    dispatchCommandSpy.mockResolvedValue({ sequence: 1 });
    const setClientSettingsSpy = vi.fn<LocalApi["persistence"]["setClientSettings"]>();
    setClientSettingsSpy.mockImplementation(async (settings) => {
      persistedClientSettings = settings;
    });

    setServerConfigSnapshot(createBaseServerConfig());
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      terminal: {} as EnvironmentApi["terminal"],
      projects: {} as EnvironmentApi["projects"],
      filesystem: {} as EnvironmentApi["filesystem"],
      git: {} as EnvironmentApi["git"],
      orchestration: {
        dispatchCommand: dispatchCommandSpy,
        getTurnDiff: vi.fn() as EnvironmentApi["orchestration"]["getTurnDiff"],
        getFullThreadDiff: vi.fn() as EnvironmentApi["orchestration"]["getFullThreadDiff"],
        subscribeShell: vi.fn(
          () => () => undefined,
        ) as EnvironmentApi["orchestration"]["subscribeShell"],
        subscribeThread: vi.fn(
          () => () => undefined,
        ) as EnvironmentApi["orchestration"]["subscribeThread"],
      },
    });

    window.nativeApi = {
      dialogs: {
        pickFolder: vi.fn().mockResolvedValue(null),
        confirm: vi.fn().mockResolvedValue(true),
      },
      shell: {
        openInEditor: vi.fn().mockResolvedValue(undefined),
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
      contextMenu: {
        show: vi.fn().mockResolvedValue(null),
      },
      persistence: {
        getClientSettings: vi.fn().mockImplementation(async () => persistedClientSettings),
        setClientSettings: setClientSettingsSpy,
        getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
        setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
        getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
        setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
        removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        getConfig: vi.fn().mockResolvedValue(createBaseServerConfig()),
        refreshProviders: vi.fn().mockResolvedValue({ providers: [] }),
        upsertKeybinding: vi.fn(),
        getSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
        updateSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
      },
    } satisfies LocalApi;

    mounted = await render(
      <AppAtomRegistryProvider>
        <HyprnavSettingsHarness />
      </AppAtomRegistryProvider>,
    );

    const globalSlotInput = page.getByRole("textbox").first();
    await expect.element(globalSlotInput).toHaveValue("1");
    await globalSlotInput.fill("9");
    await page.getByRole("button", { name: "Save defaults" }).click();
    await expect.poll(() => setClientSettingsSpy.mock.calls.length).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Show project" }).click();
    const projectSlotInput = page.getByRole("textbox").first();
    await expect.element(projectSlotInput).toHaveValue("5");
    await projectSlotInput.fill("6");
    await page.getByRole("button", { name: "Save and apply" }).click();
    await expect.poll(() => dispatchCommandSpy.mock.calls.length).toBe(1);

    await page.getByRole("button", { name: "Reset to default" }).click();
    await expect.element(projectSlotInput).toHaveValue("9");
  });
});
