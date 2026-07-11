// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createAssignmentKey } from "./lib/worktree.ts";
import {
  buildGhosttyLaunchCommand,
  createManagedClassName,
  findManagedClientByClassName,
  parseCliArgs,
  quoteShellArg,
  readRegistryRecovering,
  resolveStateFilePath,
  withRegistryLock,
  writeRegistryAtomic,
} from "./ghostty-worktree.ts";

describe("ghostty-worktree", () => {
  it("creates a stable, worktree-specific class", () => {
    const key = createAssignmentKey("/repo/.git", "/repo-wt");
    expect(createManagedClassName(key)).toMatch(/^dev\.t3tools\.t3code\.ghostty\.w[0-9a-f]{12}$/u);
  });

  it("recovers an unregistered live window by deterministic class", () => {
    expect(
      findManagedClientByClassName(
        [
          { address: "0x1", workspace: 4, pid: 42, className: "other" },
          { address: "0x2", workspace: 5, pid: 43, className: "managed" },
        ],
        "managed",
      ),
    ).toMatchObject({ address: "0x2", pid: 43 });
  });

  it("resolves state under XDG_STATE_HOME", () => {
    expect(resolveStateFilePath({ XDG_STATE_HOME: "/state" }, "/home/test")).toBe(
      "/state/ghostty-worktree/assignments.json",
    );
  });

  it("builds a Wayland Ghostty command with an exec payload", () => {
    const command = buildGhosttyLaunchCommand({
      className: "dev.t3tools.t3code.ghostty.wabc",
      cwd: "/repo/that's-fine",
      title: "Ghostty repo:feature",
      execCommand: "exec tmux",
    });
    expect(command).toContain("--gtk-single-instance=false");
    expect(command).toContain(quoteShellArg("/repo/that's-fine"));
    expect(command).toContain(quoteShellArg("exec tmux"));
  });

  it("accepts only open, list, and exec modes", () => {
    expect(parseCliArgs([])).toEqual({ mode: "open", execCommand: null });
    expect(parseCliArgs(["list-open"])).toEqual({ mode: "list-open", execCommand: null });
    expect(parseCliArgs(["--exec", "exec tmux"])).toEqual({
      mode: "open",
      execCommand: "exec tmux",
    });
    expect(() => parseCliArgs(["bad"])).toThrow("only accepts");
  });

  it("serializes concurrent registry transactions", async () => {
    const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "ghostty-lock-"));
    const statePath = NodePath.join(directory, "assignments.json");
    let active = 0;
    let maximumActive = 0;
    const transaction = () =>
      withRegistryLock(statePath, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    await Promise.all([transaction(), transaction(), transaction()]);
    expect(maximumActive).toBe(1);
    expect(NodeFs.existsSync(`${statePath}.lock`)).toBe(false);
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });

  it("recovers a stale lock", async () => {
    const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "ghostty-stale-"));
    const statePath = NodePath.join(directory, "assignments.json");
    NodeFs.mkdirSync(`${statePath}.lock`);
    NodeFs.utimesSync(`${statePath}.lock`, new Date(0), new Date(0));
    let ran = false;
    await withRegistryLock(statePath, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });

  it("quarantines malformed state and starts from an empty registry", () => {
    const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "ghostty-corrupt-"));
    const statePath = NodePath.join(directory, "assignments.json");
    NodeFs.writeFileSync(statePath, "{broken");
    expect(readRegistryRecovering(statePath, 123)).toEqual({ version: 1, assignments: {} });
    expect(NodeFs.existsSync(`${statePath}.corrupt-123-${String(process.pid)}`)).toBe(true);
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });

  it("atomically replaces state and ignores an interrupted temporary file", () => {
    const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "ghostty-atomic-"));
    const statePath = NodePath.join(directory, "assignments.json");
    writeRegistryAtomic(statePath, { version: 1, assignments: {} });
    NodeFs.writeFileSync(`${statePath}.tmp-interrupted`, "partial");
    expect(readRegistryRecovering(statePath)).toEqual({ version: 1, assignments: {} });
    expect(NodeFs.readFileSync(statePath, "utf8")).toBe(
      '{\n  "version": 1,\n  "assignments": {}\n}\n',
    );
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });
});
