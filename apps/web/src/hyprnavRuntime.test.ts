import { describe, expect, it, vi } from "vite-plus/test";

import {
  attachHyprnavWebSocketTicket,
  preferredEditorForHyprnav,
  syncHyprnavWithRetry,
} from "./hyprnavRuntime";

const request = {
  projectRoot: "/repo",
  worktreePath: "/repo/worktree",
  threadId: "thread-1",
  threadTitle: "Thread",
  hyprnav: { bindings: [] },
  lock: true,
} as const;

describe("hyprnavRuntime", () => {
  it("retries unavailable and error results until synchronization succeeds", async () => {
    const sync = vi
      .fn()
      .mockResolvedValueOnce({ status: "unavailable", message: "starting" })
      .mockResolvedValueOnce({ status: "error", message: "temporary" })
      .mockResolvedValueOnce({ status: "ok", message: null });
    const wait = vi.fn(async () => undefined);

    await expect(
      syncHyprnavWithRetry({
        sync,
        request,
        retryDelaysMs: [10, 20],
        wait,
      }),
    ).resolves.toEqual({ status: "ok", message: null });
    expect(sync).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[10], [20]]);
  });

  it("returns the final failure after exhausting retry delays", async () => {
    const sync = vi.fn(async () => ({ status: "unavailable" as const, message: "missing" }));
    const wait = vi.fn(async () => undefined);

    await expect(
      syncHyprnavWithRetry({ sync, request, retryDelaysMs: [1], wait }),
    ).resolves.toEqual({ status: "unavailable", message: "missing" });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("resolves a preferred editor only when a binding needs it", () => {
    const resolve = vi.fn(() => "vscode" as const);
    expect(preferredEditorForHyprnav([request], ["vscode"], resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();

    expect(
      preferredEditorForHyprnav(
        [
          {
            ...request,
            hyprnav: {
              bindings: [
                {
                  id: "editor",
                  slot: 2,
                  scope: "worktree",
                  workspace: { mode: "managed" },
                  action: "open-favorite-editor",
                },
              ],
            },
          },
        ],
        ["vscode"],
        resolve,
      ),
    ).toBe("vscode");
    expect(resolve).toHaveBeenCalledWith(["vscode"]);
  });

  it("replaces legacy credentials with the current websocket ticket", () => {
    expect(
      attachHyprnavWebSocketTicket("ws://127.0.0.1:3000/?token=old&wsToken=older", "fresh"),
    ).toBe("ws://127.0.0.1:3000/ws?wsTicket=fresh");
  });
});
