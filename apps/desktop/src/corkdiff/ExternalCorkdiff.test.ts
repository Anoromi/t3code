// @effect-diagnostics nodeBuiltinImport:off
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ExternalCorkdiffCommandError,
  ExternalCorkdiffManager,
  buildCorkdiffGhosttyArgs,
  buildCorkdiffEnvironment,
  buildCorkdiffTicketUpdateExpression,
  createCorkdiffGhosttyClassName,
  createCorkdiffNvimServerAddress,
  credentialRefreshDelayMs,
  findClientForClass,
  issueCorkdiffWebSocketTicketWithBearerRetry,
  parseWorkspaceId,
  runExternalCorkdiffCredentialRefreshLoop,
  runCommand,
} from "./ExternalCorkdiff.ts";

const FUTURE_TICKET_EXPIRY = Date.parse("2100-01-01T00:00:00.000Z");

describe("ExternalCorkdiff helpers", () => {
  it("surfaces the wrapped launch diagnostic", () => {
    expect(
      new ExternalCorkdiffCommandError({
        operation: "launch",
        cause: new Error("spawn socket unavailable"),
      }).message,
    ).toBe("External Corkdiff launch failed: spawn socket unavailable");
  });

  it("uses a stable hashed Ghostty class without exposing the thread id", () => {
    const className = createCorkdiffGhosttyClassName("thread-secret");
    expect(className).toMatch(/^dev\.t3tools\.t3code\.corkdiff\.t[0-9a-f]{12}$/u);
    expect(className).not.toContain("thread-secret");
  });

  it("builds direct Ghostty and Neovim arguments", () => {
    expect(
      buildCorkdiffGhosttyArgs({
        className: "cork-class",
        nvimServerAddress: "/run/user/1000/corkdiff.sock",
        threadId: "thread-1",
      }),
    ).toEqual([
      "--gtk-single-instance=false",
      "--class=cork-class",
      "--title=T3 Code Corkdiff thread-1",
      "-e",
      "nvim",
      "--listen",
      "/run/user/1000/corkdiff.sock",
      "-c",
      "lua require('codediff.config').options.t3code.server_url=vim.env.T3CODE_SERVER_URL",
      "-c",
      "lua vim.api.nvim_cmd({cmd='CorkDiff',args={'t3code',vim.env.T3CODE_THREAD_ID}}, {})",
    ]);
  });

  it("creates a stable per-thread Neovim address without exposing the thread id", () => {
    const address = createCorkdiffNvimServerAddress("thread-secret", {
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(address).toMatch(/^\/run\/user\/1000\/t3code-corkdiff-[0-9a-f]{12}\.sock$/u);
    expect(address).not.toContain("thread-secret");
  });

  it("builds a bounded Neovim credential update expression", () => {
    expect(buildCorkdiffTicketUpdateExpression("header.payload-signature")).toContain(
      '(_A)", "header.payload-signature")',
    );
    expect(() => buildCorkdiffTicketUpdateExpression('ticket";vim.cmd("qa!")')).toThrow(
      "unsupported characters",
    );
  });

  it("passes only a redacted websocket ticket credential to Corkdiff", () => {
    const env = buildCorkdiffEnvironment(
      { PATH: "/usr/bin", T3CODE_TOKEN: "legacy-bearer" },
      { cwd: "/tmp/project", threadId: "thread-1" },
      {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "short-lived-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      },
    );

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      T3CODE_SERVER_URL: "ws://127.0.0.1:3773/ws",
      T3CODE_TOKEN: "short-lived-ticket",
      T3CODE_THREAD_ID: "thread-1",
    });
  });

  it("parses workspace ids and finds the matching class", () => {
    expect(parseWorkspaceId("\n101\n")).toBe(101);
    expect(parseWorkspaceId("workspace\n")).toBeNull();
    expect(
      findClientForClass([{ address: "0xabc", class: "target", workspace: { id: 8 } }], "target"),
    ).toEqual({ address: "0xabc", workspaceId: 8 });
  });

  it("schedules credential replacement before ticket expiry", () => {
    expect(credentialRefreshDelayMs(1_000, 61_000)).toBe(30_000);
    expect(credentialRefreshDelayMs(61_000, 61_000)).toBe(0);
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
  effectIt.effect("proactively refreshes a session before its ticket expires", () =>
    Effect.gen(function* () {
      let current = true;
      const replacements: string[] = [];
      const refresh = runExternalCorkdiffCredentialRefreshLoop({
        initialExpiresAtMs: 60_000,
        isCurrent: () => current,
        resolveConnection: () =>
          Effect.succeed({
            serverUrl: "ws://127.0.0.1:3773/ws",
            token: "fresh-ticket",
            expiresAtMs: 120_000,
          }),
        refresh: async (connection) => {
          replacements.push(connection.token);
          current = false;
          return "refreshed";
        },
      });
      const fiber = yield* Effect.forkChild(refresh);

      yield* TestClock.adjust("29 seconds");
      expect(replacements).toEqual([]);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(replacements).toEqual(["fresh-ticket"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("stops the refresh loop when its managed window was closed", () =>
    Effect.gen(function* () {
      let resolutionCount = 0;
      let replacementCount = 0;
      yield* runExternalCorkdiffCredentialRefreshLoop({
        initialExpiresAtMs: 30_000,
        isCurrent: () => true,
        resolveConnection: () => {
          resolutionCount += 1;
          return Effect.succeed({
            serverUrl: "ws://127.0.0.1:3773/ws",
            token: "unused-ticket",
            expiresAtMs: 60_000,
          });
        },
        refresh: async () => {
          replacementCount += 1;
          return "closed";
        },
      });
      expect(resolutionCount).toBe(1);
      expect(replacementCount).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("invalidates a rejected cached bearer before retrying ticket issuance", () =>
    Effect.gen(function* () {
      const bearerTokens = ["stale-bearer", "fresh-bearer"];
      const issuedWith: string[] = [];
      let invalidationCount = 0;
      const ticket = yield* issueCorkdiffWebSocketTicketWithBearerRetry({
        getBearerToken: Effect.sync(() => bearerTokens.shift() ?? "unexpected-bearer"),
        invalidateBearerToken: Effect.sync(() => {
          invalidationCount += 1;
        }),
        issueTicket: (bearerToken) => {
          issuedWith.push(bearerToken);
          return bearerToken === "stale-bearer"
            ? Effect.fail(
                new ExternalCorkdiffCommandError({
                  operation: "connection",
                  cause: "expired bearer",
                }),
              )
            : Effect.succeed("fresh-ticket");
        },
        shouldInvalidateBearer: () => true,
      });

      expect(ticket).toBe("fresh-ticket");
      expect(issuedWith).toEqual(["stale-bearer", "fresh-bearer"]);
      expect(invalidationCount).toBe(1);
    }),
  );

  effectIt.effect("preserves a cached bearer after a transient ticket failure", () =>
    Effect.gen(function* () {
      const transientFailure = new ExternalCorkdiffCommandError({
        operation: "connection",
        cause: "request timed out",
      });
      let invalidationCount = 0;
      let requestCount = 0;
      const failure = yield* Effect.flip(
        issueCorkdiffWebSocketTicketWithBearerRetry({
          getBearerToken: Effect.succeed("valid-cached-bearer"),
          invalidateBearerToken: Effect.sync(() => {
            invalidationCount += 1;
          }),
          issueTicket: () => {
            requestCount += 1;
            return Effect.fail(transientFailure);
          },
          shouldInvalidateBearer: () => false,
        }),
      );

      expect(failure).toBe(transientFailure);
      expect(requestCount).toBe(1);
      expect(invalidationCount).toBe(0);
    }),
  );

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
        {
          serverUrl: "ws://127.0.0.1:3773/ws",
          token: "ticket",
          expiresAtMs: FUTURE_TICKET_EXPIRY,
        },
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
          T3CODE_TOKEN: "ticket",
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
    const connection = {
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "ticket",
      expiresAtMs: FUTURE_TICKET_EXPIRY,
    };
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
    const connection = {
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "ticket",
      expiresAtMs: FUTURE_TICKET_EXPIRY,
    };
    await manager.launch(input, connection);
    await expect(manager.focusExisting("thread-1")).resolves.toBeNull();
    await expect(manager.launch(input, connection)).resolves.toEqual({
      workspaceId: 103,
      reused: false,
    });
  });

  it("leaves an unmanaged Ghostty intact until a fresh ticket is available", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const run = vi.fn().mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ address: "0x104", class: className, workspace: { id: 104 } }]),
      stderr: "",
    });
    const manager = new ExternalCorkdiffManager(run, {});

    await expect(manager.focusExisting("thread-1")).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("adopts a Hyprnav-launched Corkdiff through the shared per-thread socket", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ address: "0x104", class: className, workspace: { id: 104 } }]),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "1", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {
      XDG_RUNTIME_DIR: "/run/user/1000",
    });

    await expect(
      manager.focusExisting("thread-1", {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "fresh-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      }),
    ).resolves.toEqual({ workspaceId: 104, reused: true });
    expect(run).toHaveBeenNthCalledWith(2, "nvim", [
      "--server",
      "/run/user/1000/t3code-corkdiff-4b0a5fefc328.sock",
      "--remote-expr",
      expect.stringContaining("fresh-ticket"),
    ]);
    expect(run).not.toHaveBeenCalledWith("hyprctl", expect.arrayContaining(["closewindow"]));
  });

  it("keeps an expired managed Ghostty focusable while credential replacement is pending", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const liveClient = JSON.stringify([
      { address: "0x105", class: className, workspace: { id: 105 } },
    ]);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "105\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {}, { attempts: 1, delayMs: 0 });
    await manager.launch(
      { cwd: "/tmp/project", threadId: "thread-1" },
      {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "ticket",
        expiresAtMs: 61_000,
      },
    );
    await expect(manager.focusExisting("thread-1")).resolves.toEqual({
      workspaceId: 105,
      reused: true,
    });
    expect(run).toHaveBeenCalledTimes(5);
    expect(run).not.toHaveBeenCalledWith("nvim", expect.anything());
    expect(run).not.toHaveBeenCalledWith("hyprctl", expect.arrayContaining(["closewindow"]));
  });

  it("refreshes a live managed Ghostty in place", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const liveClient = JSON.stringify([
      { address: "0x107", class: className, workspace: { id: 107 } },
    ]);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "107\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "1", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, { XDG_RUNTIME_DIR: "/run/user/1000" });
    const input = { cwd: "/tmp/project", threadId: "thread-1" };
    await manager.launch(input, {
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "old-ticket",
      expiresAtMs: FUTURE_TICKET_EXPIRY,
    });

    await expect(
      manager.refreshCredential(input.threadId, {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "fresh-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      }),
    ).resolves.toBe("refreshed");
    expect(run).toHaveBeenNthCalledWith(
      4,
      "nvim",
      expect.arrayContaining([
        "--server",
        "/run/user/1000/t3code-corkdiff-4b0a5fefc328.sock",
        "--remote-expr",
        expect.stringContaining("fresh-ticket"),
      ]),
    );
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("replaces a managed Ghostty after its live Neovim endpoint rejects refresh", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const liveClient = JSON.stringify([
      { address: "0x108", class: className, workspace: { id: 108 } },
    ]);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "108\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockRejectedValueOnce(new Error("nvim timed out"))
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockRejectedValueOnce(new Error("nvim timed out again"))
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {}, { attempts: 1, delayMs: 0 });
    const input = { cwd: "/tmp/project", threadId: "thread-1" };
    await manager.launch(input, {
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "old-ticket",
      expiresAtMs: FUTURE_TICKET_EXPIRY,
    });

    await expect(
      manager.refreshCredential(input.threadId, {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "fresh-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      }),
    ).rejects.toThrow("nvim timed out");
    await expect(manager.focusExisting(input.threadId)).resolves.toBeNull();
    await expect(
      manager.focusExisting(input.threadId, {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "newest-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      }),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledWith("hyprctl", ["dispatch", "closewindow", "address:0x108"]);
  });

  it("preserves a refresh failure recorded while the managed window is being focused", async () => {
    let resolveWorkspace!: (result: { code: number; stdout: string; stderr: string }) => void;
    const workspaceResult = new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        resolveWorkspace = resolve;
      },
    );
    const className = createCorkdiffGhosttyClassName("thread-1");
    const liveClient = JSON.stringify([
      { address: "0x109", class: className, workspace: { id: 109 } },
    ]);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "109\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockReturnValueOnce(workspaceResult)
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "nvim rpc unavailable" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {});
    const input = { cwd: "/tmp/project", threadId: "thread-1" };
    await manager.launch(input, {
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "old-ticket",
      expiresAtMs: FUTURE_TICKET_EXPIRY,
    });

    const focus = manager.focusExisting(input.threadId);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));
    await expect(
      manager.refreshCredential(input.threadId, {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "fresh-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      }),
    ).rejects.toThrow("nvim rpc unavailable");
    resolveWorkspace({ code: 0, stdout: "", stderr: "" });
    await expect(focus).resolves.toEqual({ workspaceId: 109, reused: true });

    await expect(manager.focusExisting(input.threadId)).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(9);
  });

  it("does not let a rejected stale probe delete a replacement session", async () => {
    let rejectProbe!: (error: Error) => void;
    const probeResult = new Promise<{ code: number; stdout: string; stderr: string }>(
      (_resolve, reject) => {
        rejectProbe = reject;
      },
    );
    const className = createCorkdiffGhosttyClassName("thread-1");
    const oldClient = JSON.stringify([
      { address: "0x110", class: className, workspace: { id: 110 } },
    ]);
    const newClient = JSON.stringify([
      { address: "0x111", class: className, workspace: { id: 111 } },
    ]);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "110\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: oldClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: oldClient, stderr: "" })
      .mockReturnValueOnce(probeResult)
      .mockResolvedValueOnce({ code: 0, stdout: "111\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: newClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: newClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {});
    const input = { cwd: "/tmp/project", threadId: "thread-1" };
    const connection = {
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "ticket",
      expiresAtMs: FUTURE_TICKET_EXPIRY,
    };
    await manager.launch(input, connection);

    const staleProbe = manager.focusExisting(input.threadId, connection);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));
    await manager.launch(input, connection);
    rejectProbe(new Error("stale probe timed out"));
    await expect(staleProbe).resolves.toBeNull();

    await expect(manager.focusExisting(input.threadId)).resolves.toEqual({
      workspaceId: 111,
      reused: true,
    });
    expect(run).not.toHaveBeenCalledWith("hyprctl", expect.arrayContaining(["closewindow"]));
  });

  it("reports a managed window closed when it exits during a rejected refresh", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const liveClient = JSON.stringify([
      { address: "0x112", class: className, workspace: { id: 112 } },
    ]);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "112\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockRejectedValueOnce(new Error("nvim timed out"))
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {});
    const input = { cwd: "/tmp/project", threadId: "thread-1" };
    await manager.launch(input, {
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "old-ticket",
      expiresAtMs: FUTURE_TICKET_EXPIRY,
    });

    await expect(
      manager.refreshCredential(input.threadId, {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "fresh-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      }),
    ).resolves.toBe("closed");
    expect(run).toHaveBeenCalledTimes(5);
  });

  it("keeps a failed refresh marked unhealthy when liveness inspection rejects", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const liveClient = JSON.stringify([
      { address: "0x113", class: className, workspace: { id: 113 } },
    ]);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "113\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" })
      .mockRejectedValueOnce(new Error("nvim timed out"))
      .mockRejectedValueOnce(new Error("hyprctl timed out"))
      .mockResolvedValueOnce({ code: 0, stdout: liveClient, stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {});
    const input = { cwd: "/tmp/project", threadId: "thread-1" };
    await manager.launch(input, {
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "old-ticket",
      expiresAtMs: FUTURE_TICKET_EXPIRY,
    });

    await expect(
      manager.refreshCredential(input.threadId, {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "fresh-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      }),
    ).rejects.toThrow("nvim timed out");
    await expect(manager.focusExisting(input.threadId)).resolves.toBeNull();
  });

  it("waits for the target address when another same-class client is listed first", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const staleClient = { address: "0x114", class: className, workspace: { id: 114 } };
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "114\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([staleClient]), stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([staleClient]), stderr: "" })
      .mockRejectedValueOnce(new Error("nvim timed out"))
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([
          { address: "0x115", class: className, workspace: { id: 115 } },
          staleClient,
        ]),
        stderr: "",
      });
    const manager = new ExternalCorkdiffManager(run, {}, { attempts: 1, delayMs: 0 });
    const connection = {
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "ticket",
      expiresAtMs: FUTURE_TICKET_EXPIRY,
    };
    await manager.launch({ cwd: "/tmp/project", threadId: "thread-1" }, connection);

    await expect(manager.focusExisting("thread-1", connection)).rejects.toThrow(
      "did not close before its replacement timeout",
    );
  });

  it("stops credential refresh when the managed window was closed", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "107\n", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ address: "0x107", class: className, workspace: { id: 107 } }]),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {});
    await manager.launch(
      { cwd: "/tmp/project", threadId: "thread-1" },
      {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "old-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      },
    );

    await expect(
      manager.refreshCredential("thread-1", {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "fresh-ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      }),
    ).resolves.toBe("closed");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("treats a client that closes during focus as stale", async () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "106\n", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ address: "0x106", class: className, workspace: { id: 106 } }]),
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ address: "0x106", class: className, workspace: { id: 106 } }]),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "workspace disappeared" })
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    const manager = new ExternalCorkdiffManager(run, {});
    await manager.launch(
      { cwd: "/tmp/project", threadId: "thread-1" },
      {
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "ticket",
        expiresAtMs: FUTURE_TICKET_EXPIRY,
      },
    );

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
        {
          serverUrl: "ws://127.0.0.1:3773/ws",
          token: "ticket",
          expiresAtMs: FUTURE_TICKET_EXPIRY,
        },
      ),
    ).rejects.toThrow("did not create a Ghostty window");
  });
});
