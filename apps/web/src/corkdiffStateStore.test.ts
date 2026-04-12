import { ThreadId, type TerminalEvent } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useCorkdiffStateStore } from "./corkdiffStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeTerminalEvent(
  type: TerminalEvent["type"],
  overrides: Partial<TerminalEvent> = {},
): TerminalEvent {
  const base = {
    threadId: THREAD_ID,
    terminalId: "corkdiff.nvim",
    createdAt: "2026-04-11T12:00:00.000Z",
  };

  switch (type) {
    case "output":
      return { ...base, type, data: "hello\n", ...overrides } as TerminalEvent;
    case "activity":
      return { ...base, type, hasRunningSubprocess: true, ...overrides } as TerminalEvent;
    case "error":
      return { ...base, type, message: "boom", ...overrides } as TerminalEvent;
    case "cleared":
      return { ...base, type, ...overrides } as TerminalEvent;
    case "exited":
      return { ...base, type, exitCode: 0, exitSignal: null, ...overrides } as TerminalEvent;
    case "started":
    case "restarted":
      return {
        ...base,
        type,
        snapshot: {
          threadId: THREAD_ID,
          terminalId: "corkdiff.nvim",
          cwd: "/tmp/worktree",
          worktreePath: "/tmp/worktree",
          status: "running",
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-11T12:00:00.000Z",
        },
        ...overrides,
      } as TerminalEvent;
  }
}

describe("corkdiffStateStore", () => {
  beforeEach(() => {
    useCorkdiffStateStore.setState({
      byThreadId: {},
    });
  });

  it("applies snapshots to thread status and paths", () => {
    useCorkdiffStateStore.getState().applySnapshot(THREAD_ID, {
      threadId: THREAD_ID,
      terminalId: "corkdiff.nvim",
      cwd: "/tmp/worktree",
      worktreePath: "/tmp/worktree",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-11T12:00:00.000Z",
    });

    expect(useCorkdiffStateStore.getState().byThreadId[THREAD_ID]).toMatchObject({
      launched: true,
      status: "running",
      cwd: "/tmp/worktree",
      worktreePath: "/tmp/worktree",
      lastError: null,
    });
  });

  it("marks started lifecycle events running", () => {
    useCorkdiffStateStore.getState().applyLifecycleEvent(THREAD_ID, makeTerminalEvent("started"));

    expect(useCorkdiffStateStore.getState().byThreadId[THREAD_ID]).toMatchObject({
      launched: true,
      status: "running",
      cwd: "/tmp/worktree",
      worktreePath: "/tmp/worktree",
      lastError: null,
    });
  });

  it("stores lifecycle errors", () => {
    useCorkdiffStateStore.getState().applyLifecycleEvent(THREAD_ID, makeTerminalEvent("error"));

    expect(useCorkdiffStateStore.getState().byThreadId[THREAD_ID]).toMatchObject({
      launched: true,
      status: "error",
      lastError: "boom",
    });
  });

  it("marks exited lifecycle events", () => {
    useCorkdiffStateStore.getState().applyLifecycleEvent(THREAD_ID, makeTerminalEvent("exited"));

    expect(useCorkdiffStateStore.getState().byThreadId[THREAD_ID]).toMatchObject({
      launched: true,
      status: "exited",
    });
  });

  it("returns the previous state object for output events", () => {
    useCorkdiffStateStore.getState().markLaunching(THREAD_ID, "/tmp/worktree", "/tmp/worktree");

    const previousState = useCorkdiffStateStore.getState();
    const previousThreadState = previousState.byThreadId[THREAD_ID];

    useCorkdiffStateStore.getState().applyLifecycleEvent(THREAD_ID, makeTerminalEvent("output"));

    const nextState = useCorkdiffStateStore.getState();
    expect(nextState).toBe(previousState);
    expect(nextState.byThreadId[THREAD_ID]).toBe(previousThreadState);
  });

  it("returns the previous state object for activity events", () => {
    useCorkdiffStateStore.getState().markLaunching(THREAD_ID, "/tmp/worktree", "/tmp/worktree");

    const previousState = useCorkdiffStateStore.getState();
    const previousThreadState = previousState.byThreadId[THREAD_ID];

    useCorkdiffStateStore.getState().applyLifecycleEvent(THREAD_ID, makeTerminalEvent("activity"));

    const nextState = useCorkdiffStateStore.getState();
    expect(nextState).toBe(previousState);
    expect(nextState.byThreadId[THREAD_ID]).toBe(previousThreadState);
  });

  it("clears Corkdiff thread state", () => {
    const store = useCorkdiffStateStore.getState();
    store.applyLifecycleEvent(THREAD_ID, makeTerminalEvent("started"));
    store.clearThread(THREAD_ID);

    expect(useCorkdiffStateStore.getState().byThreadId[THREAD_ID]).toBeUndefined();
  });
});
