import * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  DesktopHyprnavCorkdiffConnectionInput,
  DesktopHyprnavLockInput,
  DesktopHyprnavScopedSlot,
  DesktopHyprnavSyncInput,
  DesktopHyprnavSyncResult,
  EditorId,
  ProjectHyprnavBinding,
  ProjectHyprnavScope,
} from "@t3tools/contracts";
import { resolveEditorLaunch } from "@t3tools/shared/editorLaunch";

import { buildCorkdiffGhosttyArgs, createCorkdiffGhosttyClassName } from "./externalCorkdiff.ts";

const HYPRNAV_CLIENT_ID = "t3code";
const WORKTREE_TERMINAL_EXEC_COMMAND = "exec tmux";

interface HyprnavEnvironmentIds {
  readonly projectEnvId: string;
  readonly worktreeEnvId: string;
  readonly threadEnvId: string | null;
  readonly lockEnvId: string;
  readonly targetPath: string;
}

interface HyprnavBinding {
  readonly envId: string;
  readonly slot: number;
  readonly command: string;
}

type HyprnavBindingResolution =
  | {
      readonly tag: "ok";
      readonly binding: HyprnavBinding | null;
    }
  | {
      readonly tag: "error";
      readonly result: DesktopHyprnavSyncResult;
    };

type HyprnavBindingsResolution =
  | {
      readonly tag: "ok";
      readonly bindings: readonly HyprnavBinding[];
    }
  | {
      readonly tag: "error";
      readonly result: DesktopHyprnavSyncResult;
    };

interface CanonicalHyprnavSyncInput extends Omit<DesktopHyprnavSyncInput, "projectRoot"> {
  readonly projectRoot: string;
  readonly worktreePath: string | null;
  readonly threadId: string | null;
  readonly clearBindings: readonly DesktopHyprnavScopedSlot[];
  readonly corkdiffConnection: DesktopHyprnavCorkdiffConnectionInput | null;
}

interface PendingHyprnavSync {
  input: CanonicalHyprnavSyncInput;
  waiters: Array<{
    resolve: (result: DesktopHyprnavSyncResult) => void;
    reject: (error: unknown) => void;
  }>;
}

interface PendingHyprnavLock {
  envId: string;
  waiters: Array<{
    resolve: (result: DesktopHyprnavSyncResult) => void;
    reject: (error: unknown) => void;
  }>;
}

interface HyprnavEnvironmentSyncDeps {
  readonly spawnSync: typeof ChildProcess.spawnSync;
  readonly resolvePath: (...pathSegments: string[]) => string;
  readonly realpathSync: (path: string) => string;
}

interface HyprnavTemplateContext {
  readonly projectRoot: string;
  readonly targetPath: string;
  readonly threadId: string | null;
  readonly corkdiffConnection: DesktopHyprnavCorkdiffConnectionInput | null;
}

function defaultRealpathSync(path: string): string {
  const nativeRealpathSync = FS.realpathSync.native;
  if (typeof nativeRealpathSync === "function") {
    return nativeRealpathSync(path);
  }
  return FS.realpathSync(path);
}

function normalizeSlot(rawSlot: unknown): number | null {
  return typeof rawSlot === "number" && Number.isInteger(rawSlot) && rawSlot > 0 ? rawSlot : null;
}

function normalizeScope(rawScope: unknown): ProjectHyprnavScope | null {
  return rawScope === "project" || rawScope === "worktree" || rawScope === "thread"
    ? rawScope
    : null;
}

function normalizeClearBindings(
  clearBindings: readonly DesktopHyprnavScopedSlot[] | undefined,
): DesktopHyprnavScopedSlot[] {
  if (!clearBindings || clearBindings.length === 0) {
    return [];
  }

  return [
    ...new Map(
      clearBindings.flatMap((binding) => {
        const slot = normalizeSlot(binding.slot);
        const scope = normalizeScope(binding.scope);
        if (slot === null || scope === null) {
          return [];
        }
        const normalized = { slot, scope } satisfies DesktopHyprnavScopedSlot;
        return [[`${scope}:${String(slot)}`, normalized] as const];
      }),
    ).values(),
  ].toSorted((left, right) =>
    left.scope === right.scope ? left.slot - right.slot : left.scope.localeCompare(right.scope),
  );
}

function formatCommandFailure(command: string, args: readonly string[], stderr: string): string {
  const renderedCommand = [command, ...args].map(formatArgForDisplay).join(" ");
  return stderr.length > 0 ? `${renderedCommand}: ${stderr}` : `${renderedCommand} failed.`;
}

function formatArgForDisplay(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : quoteShellArg(value);
}

function isHyprnavUnavailableResult(result: ChildProcess.SpawnSyncReturns<string>): boolean {
  const errorCode =
    result.error && "code" in result.error && typeof result.error.code === "string"
      ? result.error.code
      : null;
  return errorCode === "ENOENT";
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hashHyprnavSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function buildHyprnavEnvironmentIds(input: {
  readonly projectRoot: string;
  readonly worktreePath: string | null;
  readonly threadId: string | null;
}): HyprnavEnvironmentIds {
  const projectHash = hashHyprnavSegment(input.projectRoot);
  const targetPath = input.worktreePath ?? input.projectRoot;
  const pathHash = hashHyprnavSegment(targetPath);
  const projectEnvId = `p.${projectHash}`;
  const worktreeEnvId = `${projectEnvId}.w.${pathHash}`;
  const threadEnvId = input.threadId ? `${worktreeEnvId}.t.${input.threadId}` : null;
  return {
    projectEnvId,
    worktreeEnvId,
    threadEnvId,
    lockEnvId: threadEnvId ?? worktreeEnvId,
    targetPath,
  };
}

function resolveBindingTargetPath(input: {
  readonly projectRoot: string;
  readonly targetPath: string;
  readonly scope: ProjectHyprnavScope;
}): string {
  return input.scope === "project" ? input.projectRoot : input.targetPath;
}

function buildWorktreeTerminalCommand(input: { readonly environmentPath: string }): string {
  return [
    "exec",
    "ghostty",
    "--gtk-single-instance=false",
    `--working-directory=${quoteShellArg(input.environmentPath)}`,
    "-e",
    "sh",
    "-lc",
    quoteShellArg(WORKTREE_TERMINAL_EXEC_COMMAND),
  ].join(" ");
}

function buildEditorCommand(input: {
  readonly environmentPath: string;
  readonly preferredEditor: EditorId | null | undefined;
}): string | null {
  if (!input.preferredEditor) {
    return null;
  }

  const launch = resolveEditorLaunch({
    editor: input.preferredEditor,
    target: input.environmentPath,
  });
  if (!launch) {
    return null;
  }

  return [launch.command, ...launch.args].map(quoteShellArg).join(" ");
}

function buildCorkdiffGhosttyCommand(input: {
  readonly cwd: string;
  readonly serverUrl: string;
  readonly token: string | null;
  readonly threadId: string;
}): string {
  const className = createCorkdiffGhosttyClassName(input.threadId);
  return [
    "cd",
    quoteShellArg(input.cwd),
    "&&",
    "exec",
    "ghostty",
    ...buildCorkdiffGhosttyArgs({ ...input, className }).map(quoteShellArg),
  ].join(" ");
}

function resolveTemplatePlaceholder(
  name: string,
  context: HyprnavTemplateContext,
): string | null | undefined {
  switch (name) {
    case "projectRoot":
      return quoteShellArg(context.projectRoot);
    case "worktreePath":
      return quoteShellArg(context.targetPath);
    case "threadId":
      return context.threadId ? quoteShellArg(context.threadId) : null;
    case "corkdiffServerUrl":
      return context.corkdiffConnection
        ? quoteShellArg(context.corkdiffConnection.serverUrl)
        : null;
    case "corkdiffToken":
      return context.corkdiffConnection
        ? quoteShellArg(context.corkdiffConnection.token ?? "")
        : null;
    case "corkdiffLaunchCommand":
      return context.corkdiffConnection && context.threadId
        ? buildCorkdiffGhosttyCommand({
            cwd: context.targetPath,
            serverUrl: context.corkdiffConnection.serverUrl,
            token: context.corkdiffConnection.token,
            threadId: context.threadId,
          })
        : null;
    default:
      return undefined;
  }
}

function expandHyprnavCommandTemplate(
  template: string,
  context: HyprnavTemplateContext,
):
  | { readonly ok: true; readonly command: string }
  | { readonly ok: false; readonly message: string } {
  const placeholderPattern = /\{([A-Za-z][A-Za-z0-9]*)\}/gu;
  let missingPlaceholder: string | null = null;
  let unknownPlaceholder: string | null = null;
  const command = template.replaceAll(placeholderPattern, (_match, rawName: string) => {
    const replacement = resolveTemplatePlaceholder(rawName, context);
    if (replacement === undefined) {
      unknownPlaceholder = rawName;
      return "";
    }
    if (replacement === null) {
      missingPlaceholder = rawName;
      return "";
    }
    return replacement;
  });

  if (unknownPlaceholder) {
    return {
      ok: false,
      message: `Hyprnav command uses an unknown placeholder: {${unknownPlaceholder}}.`,
    };
  }
  if (missingPlaceholder) {
    return {
      ok: false,
      message: `Hyprnav command requires {${missingPlaceholder}} for this scope.`,
    };
  }

  return { ok: true, command };
}

export class HyprnavEnvironmentSync {
  private readonly deps: HyprnavEnvironmentSyncDeps;
  private readonly activeKeys = new Set<string>();
  private readonly pendingByKey = new Map<string, PendingHyprnavSync>();
  private readonly activeLockKeys = new Set<string>();
  private readonly pendingLockByKey = new Map<string, PendingHyprnavLock>();

  constructor(deps: HyprnavEnvironmentSyncDeps) {
    this.deps = deps;
  }

  async sync(input: DesktopHyprnavSyncInput): Promise<DesktopHyprnavSyncResult> {
    const canonicalInput = this.canonicalizeInput(input);
    const syncKey = buildHyprnavEnvironmentIds(canonicalInput).lockEnvId;

    return await new Promise<DesktopHyprnavSyncResult>((resolve, reject) => {
      const existingPending = this.pendingByKey.get(syncKey);
      if (existingPending) {
        existingPending.input = mergePendingSyncInputs(existingPending.input, canonicalInput);
        existingPending.waiters.push({ resolve, reject });
      } else {
        this.pendingByKey.set(syncKey, {
          input: canonicalInput,
          waiters: [{ resolve, reject }],
        });
      }

      this.drain(syncKey);
    });
  }

  async lockEnvironment(input: DesktopHyprnavLockInput): Promise<DesktopHyprnavSyncResult> {
    return await new Promise<DesktopHyprnavSyncResult>((resolve, reject) => {
      const existingPending = this.pendingLockByKey.get(input.envId);
      if (existingPending) {
        existingPending.waiters.push({ resolve, reject });
      } else {
        this.pendingLockByKey.set(input.envId, {
          envId: input.envId,
          waiters: [{ resolve, reject }],
        });
      }

      this.drainLock(input.envId);
    });
  }

  private canonicalizeEnvironmentPath(environmentPath: string): string {
    const resolvedEnvironmentPath = this.deps.resolvePath(environmentPath);
    return this.deps.realpathSync(resolvedEnvironmentPath);
  }

  private canonicalizeInput(input: DesktopHyprnavSyncInput): CanonicalHyprnavSyncInput {
    return {
      ...input,
      projectRoot: this.canonicalizeEnvironmentPath(input.projectRoot),
      worktreePath: input.worktreePath
        ? this.canonicalizeEnvironmentPath(input.worktreePath)
        : null,
      threadId:
        typeof input.threadId === "string" && input.threadId.trim().length > 0
          ? input.threadId.trim()
          : null,
      clearBindings: normalizeClearBindings(input.clearBindings),
      corkdiffConnection:
        input.corkdiffConnection && input.corkdiffConnection.serverUrl.trim().length > 0
          ? {
              serverUrl: input.corkdiffConnection.serverUrl.trim(),
              token:
                typeof input.corkdiffConnection.token === "string"
                  ? input.corkdiffConnection.token
                  : null,
            }
          : null,
    };
  }

  private drain(syncKey: string): void {
    if (this.activeKeys.has(syncKey)) {
      return;
    }

    const pending = this.pendingByKey.get(syncKey);
    if (!pending) {
      return;
    }

    this.pendingByKey.delete(syncKey);
    this.activeKeys.add(syncKey);

    void this.runPending(syncKey, pending);
  }

  private async runPending(syncKey: string, initialPending: PendingHyprnavSync): Promise<void> {
    let pending = initialPending;
    await Promise.resolve();

    const queued = this.pendingByKey.get(syncKey);
    if (queued) {
      this.pendingByKey.delete(syncKey);
      pending = {
        input: mergePendingSyncInputs(pending.input, queued.input),
        waiters: [...pending.waiters, ...queued.waiters],
      };
    }

    try {
      const result = this.performSync(pending.input);
      for (const waiter of pending.waiters) {
        waiter.resolve(result);
      }
    } catch (error) {
      for (const waiter of pending.waiters) {
        waiter.reject(error);
      }
    } finally {
      this.activeKeys.delete(syncKey);
      this.drain(syncKey);
    }
  }

  private drainLock(envId: string): void {
    if (this.activeLockKeys.has(envId)) {
      return;
    }

    const pending = this.pendingLockByKey.get(envId);
    if (!pending) {
      return;
    }

    this.pendingLockByKey.delete(envId);
    this.activeLockKeys.add(envId);

    void this.runPendingLock(envId, pending);
  }

  private async runPendingLock(envId: string, initialPending: PendingHyprnavLock): Promise<void> {
    let pending = initialPending;
    await Promise.resolve();

    const queued = this.pendingLockByKey.get(envId);
    if (queued) {
      this.pendingLockByKey.delete(envId);
      pending = {
        envId,
        waiters: [...pending.waiters, ...queued.waiters],
      };
    }

    try {
      const result = this.runHyprnav(["lock", pending.envId]);
      for (const waiter of pending.waiters) {
        waiter.resolve(result);
      }
    } catch (error) {
      for (const waiter of pending.waiters) {
        waiter.reject(error);
      }
    } finally {
      this.activeLockKeys.delete(envId);
      this.drainLock(envId);
    }
  }

  private performSync(input: CanonicalHyprnavSyncInput): DesktopHyprnavSyncResult {
    const envIds = buildHyprnavEnvironmentIds(input);
    const bindingsResult = this.collectHyprnavBindings(input, envIds);
    if (bindingsResult.tag === "error") {
      return bindingsResult.result;
    }

    const envEnsureTargets = [
      { envId: envIds.projectEnvId, cwd: input.projectRoot },
      { envId: envIds.worktreeEnvId, cwd: envIds.targetPath },
      ...(envIds.threadEnvId ? [{ envId: envIds.threadEnvId, cwd: envIds.targetPath }] : []),
    ];

    for (const target of envEnsureTargets) {
      const ensureResult = this.runHyprnav([
        "env",
        "ensure",
        "--env",
        target.envId,
        "--cwd",
        target.cwd,
        "--client",
        HYPRNAV_CLIENT_ID,
      ]);
      if (ensureResult.status !== "ok") {
        return ensureResult;
      }
    }

    for (const binding of input.clearBindings) {
      const envId = resolveScopeEnvId(binding.scope, envIds);
      if (!envId) {
        continue;
      }
      const clearCommandResult = this.runHyprnav([
        "slot",
        "command",
        "clear",
        "--env",
        envId,
        "--slot",
        String(binding.slot),
      ]);
      if (clearCommandResult.status !== "ok") {
        return clearCommandResult;
      }

      const clearSlotResult = this.runHyprnav([
        "slot",
        "clear",
        "--env",
        envId,
        "--slot",
        String(binding.slot),
      ]);
      if (clearSlotResult.status !== "ok") {
        return clearSlotResult;
      }
    }

    for (const binding of bindingsResult.bindings) {
      const assignResult = this.runHyprnav([
        "slot",
        "assign",
        "--env",
        binding.envId,
        "--slot",
        String(binding.slot),
        "--managed",
        "--client",
        HYPRNAV_CLIENT_ID,
      ]);
      if (assignResult.status !== "ok") {
        return assignResult;
      }

      const commandResult = this.runHyprnav([
        "slot",
        "command",
        "set",
        "--env",
        binding.envId,
        "--slot",
        String(binding.slot),
        "--",
        "sh",
        "-lc",
        binding.command,
      ]);
      if (commandResult.status !== "ok") {
        return commandResult;
      }
    }

    if (input.lock) {
      const lockResult = this.runHyprnav(["lock", envIds.lockEnvId]);
      if (lockResult.status !== "ok") {
        return lockResult;
      }
    }

    return { status: "ok", message: null };
  }

  private collectHyprnavBindings(
    input: CanonicalHyprnavSyncInput,
    envIds: HyprnavEnvironmentIds,
  ): HyprnavBindingsResolution {
    const bindings: HyprnavBinding[] = [];
    for (const binding of input.hyprnav.bindings) {
      const resolved = this.resolveBinding(input, envIds, binding);
      if (resolved.tag === "error") {
        return resolved;
      }
      if (resolved.binding) {
        bindings.push(resolved.binding);
      }
    }
    return { tag: "ok", bindings };
  }

  private resolveBinding(
    input: CanonicalHyprnavSyncInput,
    envIds: HyprnavEnvironmentIds,
    binding: ProjectHyprnavBinding,
  ): HyprnavBindingResolution {
    const slot = normalizeSlot(binding.slot);
    if (slot === null) {
      return { tag: "ok", binding: null };
    }

    const envId = resolveScopeEnvId(binding.scope, envIds);
    if (!envId) {
      return { tag: "ok", binding: null };
    }

    const targetPath = resolveBindingTargetPath({
      projectRoot: input.projectRoot,
      targetPath: envIds.targetPath,
      scope: binding.scope,
    });

    switch (binding.action) {
      case "worktree-terminal":
        return {
          tag: "ok",
          binding: {
            envId,
            slot,
            command: buildWorktreeTerminalCommand({
              environmentPath: targetPath,
            }),
          },
        };
      case "open-favorite-editor": {
        const command = buildEditorCommand({
          environmentPath: targetPath,
          preferredEditor: input.preferredEditor,
        });
        return command
          ? {
              tag: "ok",
              binding: { envId, slot, command },
            }
          : {
              tag: "error",
              result: {
                status: "unavailable",
                message: "No available favorite editor is configured.",
              },
            };
      }
      case "shell-command": {
        const command = expandHyprnavCommandTemplate(binding.command, {
          projectRoot: input.projectRoot,
          targetPath: envIds.targetPath,
          threadId: input.threadId,
          corkdiffConnection: input.corkdiffConnection,
        });
        if (!command.ok) {
          return {
            tag: "error",
            result: { status: "error", message: command.message },
          };
        }

        return {
          tag: "ok",
          binding: {
            envId,
            slot,
            command: command.command,
          },
        };
      }
    }
  }

  private runHyprnav(args: readonly string[]): DesktopHyprnavSyncResult {
    const result = this.deps.spawnSync("hyprnav", [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (isHyprnavUnavailableResult(result)) {
      return {
        status: "unavailable",
        message: "hyprnav is not installed or not available in PATH.",
      };
    }

    if (result.status === 0) {
      return { status: "ok", message: null };
    }

    return {
      status: "error",
      message: formatCommandFailure("hyprnav", args, result.stderr.trim()),
    };
  }
}

function resolveScopeEnvId(
  scope: ProjectHyprnavScope,
  envIds: HyprnavEnvironmentIds,
): string | null {
  switch (scope) {
    case "project":
      return envIds.projectEnvId;
    case "worktree":
      return envIds.worktreeEnvId;
    case "thread":
      return envIds.threadEnvId;
  }
}

function mergePendingSyncInputs(
  current: CanonicalHyprnavSyncInput,
  next: CanonicalHyprnavSyncInput,
): CanonicalHyprnavSyncInput {
  return {
    ...next,
    lock: current.lock || next.lock,
    clearBindings: normalizeClearBindings([...current.clearBindings, ...next.clearBindings]),
  };
}

export function createHyprnavEnvironmentSync(
  deps: Partial<HyprnavEnvironmentSyncDeps> = {},
): HyprnavEnvironmentSync {
  return new HyprnavEnvironmentSync({
    spawnSync: deps.spawnSync ?? ChildProcess.spawnSync,
    resolvePath: deps.resolvePath ?? Path.resolve,
    realpathSync: deps.realpathSync ?? defaultRealpathSync,
  });
}

export {
  buildEditorCommand,
  buildHyprnavEnvironmentIds,
  buildWorktreeTerminalCommand,
  expandHyprnavCommandTemplate,
  normalizeClearBindings,
};
