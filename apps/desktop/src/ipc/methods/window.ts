import {
  ContextMenuItemSchema,
  DesktopAppBrandingSchema,
  DesktopEnvironmentBootstrapSchema,
  EditorId,
  ProjectHyprnavSettings,
  DesktopThemeSchema,
  PickFolderOptionsSchema,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { createExternalCorkdiffManager } from "../../externalCorkdiff.ts";
import { createHyprnavEnvironmentSync } from "../../hyprnav.ts";
import { createWorktreeTerminalLauncher } from "../../worktreeTerminal.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

const ContextMenuPosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

const ContextMenuInput = Schema.Struct({
  items: Schema.Array(ContextMenuItemSchema),
  position: Schema.optionalKey(ContextMenuPosition),
});

const NullableString = Schema.NullOr(Schema.String);

const ToggleExternalCorkdiffInput = Schema.Struct({
  cwd: Schema.String,
  serverUrl: Schema.String,
  token: NullableString,
  threadId: Schema.String,
});

const ToggleExternalCorkdiffResult = Schema.Struct({
  workspaceId: Schema.Number,
  reused: Schema.Boolean,
});

const OpenWorktreeTerminalInput = Schema.Struct({
  cwd: Schema.String,
});

const OpenWorktreeTerminalResult = Schema.Struct({
  worktreePath: Schema.String,
});

const OpenWorktreeTerminalEntry = Schema.Struct({
  worktreePath: Schema.String,
});

const DesktopHyprnavScopedSlot = Schema.Struct({
  slot: Schema.Number,
  scope: Schema.Literals(["project", "worktree", "thread"]),
});

const DesktopHyprnavCorkdiffConnectionInput = Schema.Struct({
  serverUrl: Schema.String,
  token: NullableString,
});

const DesktopHyprnavSyncInput = Schema.Struct({
  projectRoot: Schema.String,
  worktreePath: Schema.optionalKey(NullableString),
  threadId: Schema.optionalKey(NullableString),
  threadTitle: Schema.optionalKey(NullableString),
  hyprnav: ProjectHyprnavSettings,
  preferredEditor: Schema.optionalKey(Schema.NullOr(EditorId)),
  clearBindings: Schema.optionalKey(Schema.Array(DesktopHyprnavScopedSlot)),
  clearNames: Schema.optionalKey(Schema.Array(DesktopHyprnavScopedSlot)),
  corkdiffConnection: Schema.optionalKey(Schema.NullOr(DesktopHyprnavCorkdiffConnectionInput)),
  lock: Schema.Boolean,
});

class DesktopBridgeCommandError extends Data.TaggedError("DesktopBridgeCommandError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const DesktopHyprnavLockInput = Schema.Struct({
  envId: Schema.String,
});

const DesktopHyprnavSyncResult = Schema.Struct({
  status: Schema.Literals(["ok", "unavailable", "error"]),
  message: NullableString,
});

const externalCorkdiffManager = createExternalCorkdiffManager({
  getMainWindow: () => null,
  runtimeEnv: process.env,
});

const worktreeTerminalLauncher = createWorktreeTerminalLauncher({
  bunExecutable: process.env.T3CODE_BUN_EXECUTABLE?.trim() || "bun",
  runtimeEnv: process.env,
});

const hyprnavEnvironmentSync = createHyprnavEnvironmentSync();

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export const getAppBranding = makeSyncIpcMethod({
  channel: IpcChannels.GET_APP_BRANDING_CHANNEL,
  result: Schema.NullOr(DesktopAppBrandingSchema),
  handler: Effect.fn("desktop.ipc.window.getAppBranding")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.branding;
  }),
});

export const getLocalEnvironmentBootstrap = makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL,
  result: Schema.NullOr(DesktopEnvironmentBootstrapSchema),
  handler: Effect.fn("desktop.ipc.window.getLocalEnvironmentBootstrap")(function* () {
    const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
    const config = yield* backendManager.currentConfig;
    return Option.match(config, {
      onNone: () => null,
      onSome: ({ bootstrap, httpBaseUrl }) => ({
        label: "Local environment",
        httpBaseUrl: httpBaseUrl.href,
        wsBaseUrl: toWebSocketBaseUrl(httpBaseUrl),
        ...(bootstrap.desktopBootstrapToken
          ? { bootstrapToken: bootstrap.desktopBootstrapToken }
          : {}),
      }),
    });
  }),
});

export const pickFolder = makeIpcMethod({
  channel: IpcChannels.PICK_FOLDER_CHANNEL,
  payload: Schema.UndefinedOr(PickFolderOptionsSchema),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.pickFolder")(function* (options) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const selectedPath = yield* dialog.pickFolder({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath: environment.resolvePickFolderDefaultPath(options),
    });
    return Option.getOrNull(selectedPath);
  }),
});

export const confirm = makeIpcMethod({
  channel: IpcChannels.CONFIRM_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.confirm")(function* (message) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    return yield* electronWindow.focusedMainOrFirst.pipe(
      Effect.flatMap((owner) => dialog.confirm({ owner, message })),
    );
  }),
});

export const setTheme = makeIpcMethod({
  channel: IpcChannels.SET_THEME_CHANNEL,
  payload: DesktopThemeSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setTheme")(function* (theme) {
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    yield* electronTheme.setSource(theme);
  }),
});

export const showContextMenu = makeIpcMethod({
  channel: IpcChannels.CONTEXT_MENU_CHANNEL,
  payload: ContextMenuInput,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.showContextMenu")(function* (input) {
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window)) {
      return null;
    }

    const selectedItemId = yield* electronMenu.showContextMenu({
      window: window.value,
      items: input.items,
      position: Option.fromNullishOr(input.position),
    });
    return Option.getOrNull(selectedItemId);
  }),
});

export const openExternal = makeIpcMethod({
  channel: IpcChannels.OPEN_EXTERNAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openExternal")(function* (url) {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openExternal(url);
  }),
});

export const toggleExternalCorkdiff = makeIpcMethod({
  channel: IpcChannels.TOGGLE_EXTERNAL_CORKDIFF_CHANNEL,
  payload: ToggleExternalCorkdiffInput,
  result: ToggleExternalCorkdiffResult,
  handler: Effect.fn("desktop.ipc.window.toggleExternalCorkdiff")(function* (input) {
    return yield* Effect.tryPromise({
      try: () => externalCorkdiffManager.toggle(input),
      catch: (cause) =>
        new DesktopBridgeCommandError({ message: "Failed to toggle external Corkdiff.", cause }),
    });
  }),
});

export const openWorktreeTerminal = makeIpcMethod({
  channel: IpcChannels.OPEN_WORKTREE_TERMINAL_CHANNEL,
  payload: OpenWorktreeTerminalInput,
  result: OpenWorktreeTerminalResult,
  handler: Effect.fn("desktop.ipc.window.openWorktreeTerminal")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.tryPromise({
      try: () => worktreeTerminalLauncher.open({ cwd: input.cwd, rootDir: environment.appPath }),
      catch: (cause) =>
        new DesktopBridgeCommandError({ message: "Failed to open worktree terminal.", cause }),
    });
  }),
});

export const listOpenWorktreeTerminals = makeIpcMethod({
  channel: IpcChannels.LIST_OPEN_WORKTREE_TERMINALS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(OpenWorktreeTerminalEntry),
  handler: Effect.fn("desktop.ipc.window.listOpenWorktreeTerminals")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.tryPromise({
      try: () => worktreeTerminalLauncher.listOpen({ rootDir: environment.appPath }),
      catch: (cause) =>
        new DesktopBridgeCommandError({ message: "Failed to list worktree terminals.", cause }),
    });
  }),
});

export const syncHyprnavEnvironment = makeIpcMethod({
  channel: IpcChannels.SYNC_HYPRNAV_ENVIRONMENT_CHANNEL,
  payload: DesktopHyprnavSyncInput,
  result: DesktopHyprnavSyncResult,
  handler: Effect.fn("desktop.ipc.window.syncHyprnavEnvironment")(function* (input) {
    return yield* Effect.tryPromise({
      try: () => hyprnavEnvironmentSync.sync(input),
      catch: (cause) =>
        new DesktopBridgeCommandError({ message: "Failed to sync Hyprnav environment.", cause }),
    });
  }),
});

export const lockHyprnavEnvironment = makeIpcMethod({
  channel: IpcChannels.LOCK_HYPRNAV_ENVIRONMENT_CHANNEL,
  payload: DesktopHyprnavLockInput,
  result: DesktopHyprnavSyncResult,
  handler: Effect.fn("desktop.ipc.window.lockHyprnavEnvironment")(function* (input) {
    return yield* Effect.tryPromise({
      try: () => hyprnavEnvironmentSync.lockEnvironment(input),
      catch: (cause) =>
        new DesktopBridgeCommandError({ message: "Failed to lock Hyprnav environment.", cause }),
    });
  }),
});

export const focusAppWindow = makeIpcMethod({
  channel: IpcChannels.FOCUS_APP_WINDOW_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.focusAppWindow")(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.activate;
  }),
});
