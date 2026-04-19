import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  DesktopHyprnavLockInput,
  DesktopHyprnavSyncInput,
  DesktopHyprnavSyncResult,
  EditorId,
  ProjectHyprnavBinding,
} from "@t3tools/contracts";
import { resolveEditorLaunch } from "@t3tools/shared/editorLaunch";

const HYPRNAV_CLIENT_ID = "t3code";
const WORKTREE_TERMINAL_EXEC_COMMAND = "exec tmux";

interface HyprnavBinding {
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

interface CanonicalHyprnavSyncInput extends DesktopHyprnavSyncInput {
  readonly environmentPath: string;
  readonly clearSlots: readonly number[];
}

interface PendingHyprnavSync {
  input: CanonicalHyprnavSyncInput;
  waiters: Array<{
    resolve: (result: DesktopHyprnavSyncResult) => void;
    reject: (error: unknown) => void;
  }>;
}

interface PendingHyprnavLock {
  environmentPath: string;
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

function normalizeClearSlots(clearSlots: readonly number[] | undefined): number[] {
  if (!clearSlots || clearSlots.length === 0) {
    return [];
  }

  return [
    ...new Set(clearSlots.flatMap((slot) => (normalizeSlot(slot) === null ? [] : [slot]))),
  ].toSorted((left, right) => left - right);
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

    return await new Promise<DesktopHyprnavSyncResult>((resolve, reject) => {
      const existingPending = this.pendingByKey.get(canonicalInput.environmentPath);
      if (existingPending) {
        existingPending.input = mergePendingSyncInputs(existingPending.input, canonicalInput);
        existingPending.waiters.push({ resolve, reject });
      } else {
        this.pendingByKey.set(canonicalInput.environmentPath, {
          input: canonicalInput,
          waiters: [{ resolve, reject }],
        });
      }

      this.drain(canonicalInput.environmentPath);
    });
  }

  async lockEnvironment(input: DesktopHyprnavLockInput): Promise<DesktopHyprnavSyncResult> {
    const environmentPath = this.canonicalizeEnvironmentPath(input.environmentPath);

    return await new Promise<DesktopHyprnavSyncResult>((resolve, reject) => {
      const existingPending = this.pendingLockByKey.get(environmentPath);
      if (existingPending) {
        existingPending.waiters.push({ resolve, reject });
      } else {
        this.pendingLockByKey.set(environmentPath, {
          environmentPath,
          waiters: [{ resolve, reject }],
        });
      }

      this.drainLock(environmentPath);
    });
  }

  private canonicalizeEnvironmentPath(environmentPath: string): string {
    const resolvedEnvironmentPath = this.deps.resolvePath(environmentPath);
    return this.deps.realpathSync(resolvedEnvironmentPath);
  }

  private canonicalizeInput(input: DesktopHyprnavSyncInput): CanonicalHyprnavSyncInput {
    return {
      ...input,
      environmentPath: this.canonicalizeEnvironmentPath(input.environmentPath),
      clearSlots: normalizeClearSlots(input.clearSlots),
    };
  }

  private drain(environmentPath: string): void {
    if (this.activeKeys.has(environmentPath)) {
      return;
    }

    const pending = this.pendingByKey.get(environmentPath);
    if (!pending) {
      return;
    }

    this.pendingByKey.delete(environmentPath);
    this.activeKeys.add(environmentPath);

    void this.runPending(environmentPath, pending);
  }

  private async runPending(
    environmentPath: string,
    initialPending: PendingHyprnavSync,
  ): Promise<void> {
    let pending = initialPending;
    await Promise.resolve();

    const queued = this.pendingByKey.get(environmentPath);
    if (queued) {
      this.pendingByKey.delete(environmentPath);
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
      this.activeKeys.delete(environmentPath);
      this.drain(environmentPath);
    }
  }

  private drainLock(environmentPath: string): void {
    if (this.activeLockKeys.has(environmentPath)) {
      return;
    }

    const pending = this.pendingLockByKey.get(environmentPath);
    if (!pending) {
      return;
    }

    this.pendingLockByKey.delete(environmentPath);
    this.activeLockKeys.add(environmentPath);

    void this.runPendingLock(environmentPath, pending);
  }

  private async runPendingLock(
    environmentPath: string,
    initialPending: PendingHyprnavLock,
  ): Promise<void> {
    let pending = initialPending;
    await Promise.resolve();

    const queued = this.pendingLockByKey.get(environmentPath);
    if (queued) {
      this.pendingLockByKey.delete(environmentPath);
      pending = {
        environmentPath,
        waiters: [...pending.waiters, ...queued.waiters],
      };
    }

    try {
      const result = this.runHyprnav(["lock", pending.environmentPath]);
      for (const waiter of pending.waiters) {
        waiter.resolve(result);
      }
    } catch (error) {
      for (const waiter of pending.waiters) {
        waiter.reject(error);
      }
    } finally {
      this.activeLockKeys.delete(environmentPath);
      this.drainLock(environmentPath);
    }
  }

  private performSync(input: CanonicalHyprnavSyncInput): DesktopHyprnavSyncResult {
    const bindingsResult = this.collectHyprnavBindings(input);
    if (bindingsResult.tag === "error") {
      return bindingsResult.result;
    }

    const ensureResult = this.runHyprnav([
      "env",
      "ensure",
      "--cwd",
      input.environmentPath,
      "--client",
      HYPRNAV_CLIENT_ID,
    ]);
    if (ensureResult.status !== "ok") {
      return ensureResult;
    }

    for (const slot of input.clearSlots) {
      const clearCommandResult = this.runHyprnav([
        "slot",
        "command",
        "clear",
        "--env",
        input.environmentPath,
        "--slot",
        String(slot),
      ]);
      if (clearCommandResult.status !== "ok") {
        return clearCommandResult;
      }

      const clearSlotResult = this.runHyprnav([
        "slot",
        "clear",
        "--env",
        input.environmentPath,
        "--slot",
        String(slot),
      ]);
      if (clearSlotResult.status !== "ok") {
        return clearSlotResult;
      }
    }

    for (const binding of bindingsResult.bindings) {
      const assignResult = this.runHyprnav([
        "slot",
        "assign",
        "--cwd",
        input.environmentPath,
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
        input.environmentPath,
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
      const lockResult = this.runHyprnav(["lock", input.environmentPath]);
      if (lockResult.status !== "ok") {
        return lockResult;
      }
    }

    return { status: "ok", message: null };
  }

  private collectHyprnavBindings(input: CanonicalHyprnavSyncInput): HyprnavBindingsResolution {
    const bindings: HyprnavBinding[] = [];
    for (const binding of input.hyprnav.bindings) {
      const resolved = this.resolveBinding(input, binding);
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
    binding: ProjectHyprnavBinding,
  ): HyprnavBindingResolution {
    const slot = normalizeSlot(binding.slot);
    if (slot === null) {
      return { tag: "ok", binding: null };
    }

    switch (binding.action) {
      case "worktree-terminal":
        return {
          tag: "ok",
          binding: {
            slot,
            command: buildWorktreeTerminalCommand({
              environmentPath: input.environmentPath,
            }),
          },
        };
      case "open-favorite-editor": {
        const command = buildEditorCommand({
          environmentPath: input.environmentPath,
          preferredEditor: input.preferredEditor,
        });
        return command
          ? {
              tag: "ok",
              binding: { slot, command },
            }
          : {
              tag: "error",
              result: {
                status: "unavailable",
                message: "No available favorite editor is configured.",
              },
            };
      }
      case "shell-command":
        return {
          tag: "ok",
          binding: {
            slot,
            command: binding.command,
          },
        };
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

function mergePendingSyncInputs(
  current: CanonicalHyprnavSyncInput,
  next: CanonicalHyprnavSyncInput,
): CanonicalHyprnavSyncInput {
  return {
    ...next,
    lock: current.lock || next.lock,
    clearSlots: normalizeClearSlots([...current.clearSlots, ...next.clearSlots]),
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

export { buildEditorCommand, buildWorktreeTerminalCommand, normalizeClearSlots };
