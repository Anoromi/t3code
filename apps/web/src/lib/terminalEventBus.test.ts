import { ThreadId, type TerminalEvent } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

function makeTerminalEvent(
  threadId: ThreadId,
  terminalId: string,
  overrides: Partial<TerminalEvent> = {},
): TerminalEvent {
  return {
    type: "output",
    threadId,
    terminalId,
    createdAt: "2026-04-11T12:00:00.000Z",
    data: "hello\n",
    ...overrides,
  } as TerminalEvent;
}

describe("terminalEventBus", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("publishes only to matching thread and terminal subscribers", async () => {
    const { getTerminalEventBus } = await import("./terminalEventBus");
    const bus = getTerminalEventBus();
    const threadA = ThreadId.make("thread-a");
    const threadB = ThreadId.make("thread-b");
    const listener = vi.fn();

    bus.subscribe(threadA, "corkdiff.nvim", listener);
    bus.publish(makeTerminalEvent(threadB, "corkdiff.nvim"));
    bus.publish(makeTerminalEvent(threadA, "terminal-2"));
    bus.publish(makeTerminalEvent(threadA, "corkdiff.nvim"));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies all listeners for the same thread and terminal", async () => {
    const { getTerminalEventBus } = await import("./terminalEventBus");
    const bus = getTerminalEventBus();
    const threadId = ThreadId.make("thread-a");
    const first = vi.fn();
    const second = vi.fn();

    bus.subscribe(threadId, "corkdiff.nvim", first);
    bus.subscribe(threadId, "corkdiff.nvim", second);
    bus.publish(makeTerminalEvent(threadId, "corkdiff.nvim"));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("removes listeners on unsubscribe", async () => {
    const { getTerminalEventBus } = await import("./terminalEventBus");
    const bus = getTerminalEventBus();
    const threadId = ThreadId.make("thread-a");
    const listener = vi.fn();

    const unsubscribe = bus.subscribe(threadId, "corkdiff.nvim", listener);
    unsubscribe();
    bus.publish(makeTerminalEvent(threadId, "corkdiff.nvim"));

    expect(listener).not.toHaveBeenCalled();
  });

  it("swallows listener exceptions and continues notifying others", async () => {
    const { getTerminalEventBus } = await import("./terminalEventBus");
    const bus = getTerminalEventBus();
    const threadId = ThreadId.make("thread-a");
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();

    bus.subscribe(threadId, "corkdiff.nvim", throwing);
    bus.subscribe(threadId, "corkdiff.nvim", healthy);
    expect(() => bus.publish(makeTerminalEvent(threadId, "corkdiff.nvim"))).not.toThrow();

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
