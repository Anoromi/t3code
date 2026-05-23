import { beforeEach, describe, expect, it, vi } from "vitest";

const initMock = vi.fn<() => Promise<void>>();

vi.mock("ghostty-web", () => ({
  init: initMock,
}));

describe("ensureGhosttyWebReady", () => {
  beforeEach(() => {
    initMock.mockReset();
    vi.resetModules();
  });

  it("shares a single init call across concurrent callers", async () => {
    initMock.mockResolvedValue(undefined);
    const { ensureGhosttyWebReady } = await import("./ghosttyWeb");

    const first = ensureGhosttyWebReady();
    const second = ensureGhosttyWebReady();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it("clears the cached promise after init failure so a later retry can succeed", async () => {
    initMock.mockRejectedValueOnce(new Error("init failed"));
    initMock.mockResolvedValueOnce(undefined);
    const { ensureGhosttyWebReady } = await import("./ghosttyWeb");

    await expect(ensureGhosttyWebReady()).rejects.toThrow("init failed");
    await expect(ensureGhosttyWebReady()).resolves.toBeUndefined();
    expect(initMock).toHaveBeenCalledTimes(2);
  });
});
