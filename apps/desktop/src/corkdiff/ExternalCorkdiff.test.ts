// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ExternalCorkdiffManager,
  buildCorkdiffGhosttyArgs,
  createCorkdiffGhosttyClassName,
  findClientForClass,
  parseWorkspaceId,
  runCommand,
} from "./ExternalCorkdiff.ts";

describe("ExternalCorkdiff helpers", () => {
  it("uses a stable hashed Ghostty class without exposing the thread id", () => {
    const className = createCorkdiffGhosttyClassName("thread-secret");
    expect(className).toMatch(/^dev\.t3tools\.t3code\.corkdiff\.t[0-9a-f]{12}$/u);
    expect(className).not.toContain("thread-secret");
  });

  it("builds direct Ghostty and Neovim arguments", () => {
    expect(buildCorkdiffGhosttyArgs({ className: "cork-class", threadId: "thread-1" })).toEqual([
      "--gtk-single-instance=false",
      "--class=cork-class",
      "--title=T3 Code Corkdiff thread-1",
      "-e",
      "nvim",
      "-c",
      "lua require('codediff.config').options.t3code.server_url=vim.env.T3CODE_SERVER_URL",
      "-c",
      "lua vim.api.nvim_cmd({cmd='CorkDiff',args={'t3code',vim.env.T3CODE_THREAD_ID}}, {})",
    ]);
  });

  it("parses workspace ids and finds the matching class", () => {
    expect(parseWorkspaceId("\n101\n")).toBe(101);
    expect(parseWorkspaceId("workspace\n")).toBeNull();
    expect(
      findClientForClass([{ address: "0xabc", class: "target", workspace: { id: 8 } }], "target"),
    ).toEqual({ address: "0xabc", workspaceId: 8 });
  });

  it("preserves an immediate spawn failure after a workspace id is printed", async () => {
    await expect(
      runCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write('105\\n'); process.stderr.write('spawn socket unavailable\\n'); process.exit(1)",
        ],
        { resolveOnWorkspaceId: true },
      ),
    ).resolves.toEqual({
      code: 1,
      stdout: "105\n",
      stderr: "spawn socket unavailable\n",
    });
  });
});

describe("ExternalCorkdiffManager", () => {
  it("launches through the exact hyprnav command and reuses a live per-thread session", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: null, stdout: "101\n", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ address: "0x101", class: className, workspace: { id: 101 } }]),
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ address: "0x101", class: className, workspace: { id: 101 } }]),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, { PATH: "/usr/bin" });

    await expect(
      manager.launch(
        { cwd: "/tmp/project", threadId: "thread-1" },
        { serverUrl: "ws://127.0.0.1:3773/ws", token: "secret" },
      ),
    ).resolves.toEqual({ workspaceId: 101, reused: false });
    expect(run).toHaveBeenNthCalledWith(
      1,
      "hyprnav",
      expect.arrayContaining([
        "spawn",
        "--print-workspace-id",
        "rand",
        "--",
        "ghostty",
        `--class=${className}`,
      ]),
      expect.objectContaining({
        cwd: "/tmp/project",
        env: expect.objectContaining({
          T3CODE_SERVER_URL: "ws://127.0.0.1:3773/ws",
          T3CODE_TOKEN: "secret",
          T3CODE_THREAD_ID: "thread-1",
        }),
        resolveOnWorkspaceId: true,
      }),
    );

    await expect(manager.focusExisting("thread-1")).resolves.toEqual({
      workspaceId: 101,
      reused: true,
    });
    expect(run).toHaveBeenNthCalledWith(3, "hyprctl", ["-j", "clients"]);
    expect(run).toHaveBeenNthCalledWith(4, "hyprctl", ["dispatch", "workspace", "101"]);
    expect(run).toHaveBeenNthCalledWith(5, "hyprctl", ["dispatch", "focuswindow", "address:0x101"]);
  });

  it("coalesces concurrent launches for one thread", async () => {
    let resolveLaunch!: (value: { code: number; stdout: string; stderr: string }) => void;
    const launchResult = new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        resolveLaunch = resolve;
      },
    );
    const className = createCorkdiffGhosttyClassName("thread-1");
    const run = vi
      .fn()
      .mockReturnValueOnce(launchResult)
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ address: "0x102", class: className, workspace: { id: 102 } }]),
        stderr: "",
      });
    const manager = new ExternalCorkdiffManager(run, {});
    const connection = { serverUrl: "ws://127.0.0.1:3773/ws", token: "secret" };
    const first = manager.launch({ cwd: "/tmp/project", threadId: "thread-1" }, connection);
    const second = manager.launch({ cwd: "/tmp/project", threadId: "thread-1" }, connection);
    resolveLaunch({ code: 0, stdout: "102\n", stderr: "" });

    await expect(first).resolves.toEqual({ workspaceId: 102, reused: false });
    await expect(second).resolves.toEqual({ workspaceId: 102, reused: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("relaunches when the managed Ghostty class is gone", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "101\n", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([
          {
            address: "0x101",
            class: createCorkdiffGhosttyClassName("thread-1"),
            workspace: { id: 101 },
          },
        ]),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "103\n", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([
          {
            address: "0x103",
            class: createCorkdiffGhosttyClassName("thread-1"),
            workspace: { id: 103 },
          },
        ]),
        stderr: "",
      });
    const manager = new ExternalCorkdiffManager(run, {});
    const input = { cwd: "/tmp/project", threadId: "thread-1" };
    const connection = { serverUrl: "ws://127.0.0.1:3773/ws", token: "secret" };
    await manager.launch(input, connection);
    await expect(manager.focusExisting("thread-1")).resolves.toBeNull();
    await expect(manager.launch(input, connection)).resolves.toEqual({
      workspaceId: 103,
      reused: false,
    });
  });

  it("recovers a matching Ghostty after the desktop process restarts", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ address: "0x104", class: className, workspace: { id: 104 } }]),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {});

    await expect(manager.focusExisting("thread-1")).resolves.toEqual({
      workspaceId: 104,
      reused: true,
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("treats a client that closes during focus as stale", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ address: "0x106", class: className, workspace: { id: 106 } }]),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "workspace disappeared" })
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {});

    await expect(manager.focusExisting("thread-1")).resolves.toBeNull();
  });

  it("does not report success until the Ghostty client is observable", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: null, stdout: "105\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {}, { attempts: 1, delayMs: 0 });

    await expect(
      manager.launch(
        { cwd: "/tmp/project", threadId: "thread-1" },
        { serverUrl: "ws://127.0.0.1:3773/ws", token: "secret" },
      ),
    ).rejects.toThrow("did not create a Ghostty window");
  });
});
