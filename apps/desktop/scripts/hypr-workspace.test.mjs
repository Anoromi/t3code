import { describe, expect, it, vi } from "vitest";

import { movePidToHyprWorkspace, parseHyprWorkspaceEnv } from "./hypr-workspace.mjs";

describe("hypr workspace helpers", () => {
  it("parses a valid workspace env value", () => {
    expect(parseHyprWorkspaceEnv({ T3CODE_HYPR_WORKSPACE: "23" })).toBe(23);
  });

  it("returns null for a missing workspace env value", () => {
    expect(parseHyprWorkspaceEnv({})).toBeNull();
  });

  it("returns null and warns for an invalid workspace env value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(parseHyprWorkspaceEnv({ T3CODE_HYPR_WORKSPACE: "abc" })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });

  it("retries until the workspace move succeeds", async () => {
    const dispatch = vi
      .fn()
      .mockReturnValueOnce({ status: 1, error: undefined, signal: null })
      .mockReturnValueOnce({ status: 0, error: undefined, signal: null });
    const listClientsImpl = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ pid: 4321, address: "0xabc", workspace: { id: 23 } }])
      .mockReturnValueOnce([{ pid: 4321, address: "0xabc", workspace: { id: 23 } }])
      .mockReturnValueOnce([{ pid: 4321, address: "0xabc", workspace: { id: 23 } }]);
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await movePidToHyprWorkspace({
      workspace: 23,
      pid: 4321,
      attempts: 6,
      delayMs: 5,
      dispatch,
      listClientsImpl,
      sleepImpl,
    });

    expect(result).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, 23, 4321);
    expect(dispatch).toHaveBeenNthCalledWith(2, 23, 4321);
    expect(sleepImpl).toHaveBeenCalledTimes(4);
  });

  it("moves each client address until all windows for the pid are on the target workspace", async () => {
    const listClientsImpl = vi
      .fn()
      .mockReturnValueOnce([
        { pid: 4321, address: "0xdevtools", workspace: { id: 23 } },
        { pid: 4321, address: "0xmain", workspace: { id: 2 } },
      ])
      .mockReturnValueOnce([
        { pid: 4321, address: "0xdevtools", workspace: { id: 23 } },
        { pid: 4321, address: "0xmain", workspace: { id: 23 } },
      ])
      .mockReturnValueOnce([
        { pid: 4321, address: "0xdevtools", workspace: { id: 23 } },
        { pid: 4321, address: "0xmain", workspace: { id: 23 } },
      ])
      .mockReturnValueOnce([
        { pid: 4321, address: "0xdevtools", workspace: { id: 23 } },
        { pid: 4321, address: "0xmain", workspace: { id: 23 } },
      ]);
    const moveAddressImpl = vi.fn().mockReturnValue({
      status: 0,
      error: undefined,
      signal: null,
    });
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await movePidToHyprWorkspace({
      workspace: 23,
      pid: 4321,
      attempts: 4,
      delayMs: 5,
      listClientsImpl,
      moveAddressImpl,
      sleepImpl,
    });

    expect(result).toBe(true);
    expect(moveAddressImpl).toHaveBeenCalledTimes(1);
    expect(moveAddressImpl).toHaveBeenCalledWith(23, "0xmain");
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });

  it("does not finish early when a second window appears after the first one reaches the target workspace", async () => {
    const listClientsImpl = vi
      .fn()
      .mockReturnValueOnce([{ pid: 4321, address: "0xmain", workspace: { id: 23 } }])
      .mockReturnValueOnce([
        { pid: 4321, address: "0xmain", workspace: { id: 23 } },
        { pid: 4321, address: "0xdevtools", workspace: { id: 2 } },
      ])
      .mockReturnValueOnce([
        { pid: 4321, address: "0xmain", workspace: { id: 23 } },
        { pid: 4321, address: "0xdevtools", workspace: { id: 23 } },
      ])
      .mockReturnValueOnce([
        { pid: 4321, address: "0xmain", workspace: { id: 23 } },
        { pid: 4321, address: "0xdevtools", workspace: { id: 23 } },
      ])
      .mockReturnValueOnce([
        { pid: 4321, address: "0xmain", workspace: { id: 23 } },
        { pid: 4321, address: "0xdevtools", workspace: { id: 23 } },
      ]);
    const moveAddressImpl = vi.fn().mockReturnValue({
      status: 0,
      error: undefined,
      signal: null,
    });
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await movePidToHyprWorkspace({
      workspace: 23,
      pid: 4321,
      attempts: 5,
      delayMs: 5,
      listClientsImpl,
      moveAddressImpl,
      sleepImpl,
    });

    expect(result).toBe(true);
    expect(moveAddressImpl).toHaveBeenCalledTimes(1);
    expect(moveAddressImpl).toHaveBeenCalledWith(23, "0xdevtools");
  });

  it("warns and returns false when the workspace move never succeeds", async () => {
    const dispatch = vi.fn().mockReturnValue({
      status: 1,
      error: undefined,
      signal: null,
    });
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const logWarn = vi.fn();

    const result = await movePidToHyprWorkspace({
      workspace: 23,
      pid: 4321,
      attempts: 3,
      delayMs: 5,
      dispatch,
      listClientsImpl: vi.fn().mockReturnValue([]),
      sleepImpl,
      logWarn,
    });

    expect(result).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn.mock.calls[0]?.[0]).toContain("failed to move Electron pid 4321");
  });
});
