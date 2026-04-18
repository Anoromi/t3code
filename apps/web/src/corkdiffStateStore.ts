import {
  type ThreadId,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { create } from "zustand";

export type CorkdiffSessionStatus = "idle" | "starting" | "running" | "exited" | "error";

interface CorkdiffThreadState {
  launched: boolean;
  status: CorkdiffSessionStatus;
  cwd: string | null;
  worktreePath: string | null;
  lastError: string | null;
  restartToken: number;
  bootstrappedRestartToken: number | null;
}

interface CorkdiffStateStore {
  byThreadId: Record<ThreadId, CorkdiffThreadState>;
  ensureThread: (threadId: ThreadId, cwd: string | null, worktreePath: string | null) => void;
  markLaunching: (threadId: ThreadId, cwd: string | null, worktreePath: string | null) => void;
  applySnapshot: (threadId: ThreadId, snapshot: TerminalSessionSnapshot) => void;
  applyLifecycleEvent: (threadId: ThreadId, event: TerminalEvent) => void;
  setError: (
    threadId: ThreadId,
    message: string,
    cwd: string | null,
    worktreePath: string | null,
  ) => void;
  requestRestart: (threadId: ThreadId) => void;
  markBootstrapped: (threadId: ThreadId, restartToken: number) => void;
  clearThread: (threadId: ThreadId) => void;
}

const DEFAULT_THREAD_STATE: CorkdiffThreadState = Object.freeze({
  launched: false,
  status: "idle",
  cwd: null,
  worktreePath: null,
  lastError: null,
  restartToken: 0,
  bootstrappedRestartToken: null,
});

function getThreadState(
  byThreadId: Record<ThreadId, CorkdiffThreadState>,
  threadId: ThreadId,
): CorkdiffThreadState {
  return byThreadId[threadId] ?? DEFAULT_THREAD_STATE;
}

function statusFromSnapshot(snapshot: TerminalSessionSnapshot): CorkdiffSessionStatus {
  switch (snapshot.status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "exited":
    default:
      return "exited";
  }
}

export const useCorkdiffStateStore = create<CorkdiffStateStore>((set) => ({
  byThreadId: {},
  ensureThread: (threadId, cwd, worktreePath) =>
    set((state) => {
      if (state.byThreadId[threadId]) {
        return state;
      }
      return {
        byThreadId: {
          ...state.byThreadId,
          [threadId]: {
            ...DEFAULT_THREAD_STATE,
            cwd,
            worktreePath,
          },
        },
      };
    }),
  markLaunching: (threadId, cwd, worktreePath) =>
    set((state) => {
      const current = getThreadState(state.byThreadId, threadId);
      return {
        byThreadId: {
          ...state.byThreadId,
          [threadId]: {
            ...current,
            launched: true,
            status: "starting",
            cwd,
            worktreePath,
            lastError: null,
          },
        },
      };
    }),
  applySnapshot: (threadId, snapshot) =>
    set((state) => {
      const current = getThreadState(state.byThreadId, threadId);
      return {
        byThreadId: {
          ...state.byThreadId,
          [threadId]: {
            ...current,
            launched: true,
            status: statusFromSnapshot(snapshot),
            cwd: snapshot.cwd,
            worktreePath: snapshot.worktreePath,
            lastError: null,
          },
        },
      };
    }),
  applyLifecycleEvent: (threadId, event) =>
    set((state) => {
      const current = getThreadState(state.byThreadId, threadId);
      if (event.type === "output" || event.type === "activity" || event.type === "cleared") {
        return state;
      }

      const nextState =
        event.type === "started" || event.type === "restarted"
          ? {
              ...current,
              launched: true,
              status: "running" as const,
              cwd: event.snapshot.cwd,
              worktreePath: event.snapshot.worktreePath,
              lastError: null,
            }
          : event.type === "error"
            ? {
                ...current,
                launched: true,
                status: "error" as const,
                lastError: event.message,
              }
            : {
                ...current,
                launched: true,
                status: "exited" as const,
              };

      if (
        nextState === current ||
        (nextState.launched === current.launched &&
          nextState.status === current.status &&
          nextState.cwd === current.cwd &&
          nextState.worktreePath === current.worktreePath &&
          nextState.lastError === current.lastError &&
          nextState.restartToken === current.restartToken &&
          nextState.bootstrappedRestartToken === current.bootstrappedRestartToken)
      ) {
        return state;
      }

      return {
        byThreadId: {
          ...state.byThreadId,
          [threadId]: nextState,
        },
      };
    }),
  setError: (threadId, message, cwd, worktreePath) =>
    set((state) => {
      const current = getThreadState(state.byThreadId, threadId);
      return {
        byThreadId: {
          ...state.byThreadId,
          [threadId]: {
            ...current,
            launched: true,
            status: "error",
            cwd,
            worktreePath,
            lastError: message,
          },
        },
      };
    }),
  requestRestart: (threadId) =>
    set((state) => {
      const current = getThreadState(state.byThreadId, threadId);
      return {
        byThreadId: {
          ...state.byThreadId,
          [threadId]: {
            ...current,
            launched: true,
            status: "starting",
            lastError: null,
            restartToken: current.restartToken + 1,
          },
        },
      };
    }),
  markBootstrapped: (threadId, restartToken) =>
    set((state) => {
      const current = getThreadState(state.byThreadId, threadId);
      return {
        byThreadId: {
          ...state.byThreadId,
          [threadId]: {
            ...current,
            bootstrappedRestartToken: restartToken,
          },
        },
      };
    }),
  clearThread: (threadId) =>
    set((state) => {
      if (state.byThreadId[threadId] === undefined) {
        return state;
      }
      const { [threadId]: _removedThreadState, ...remainingThreads } = state.byThreadId;
      return {
        byThreadId: remainingThreads,
      };
    }),
}));
