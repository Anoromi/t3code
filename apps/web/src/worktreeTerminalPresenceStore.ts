import { create } from "zustand";

import { normalizeWorktreePath } from "./worktreeCleanup";

interface WorktreeTerminalPresenceState {
  openWorktreePaths: Record<string, true>;
  replaceOpenWorktrees: (paths: readonly string[]) => void;
  markOpen: (worktreePath: string) => void;
  clearAll: () => void;
}

function toOpenWorktreePathRecord(paths: readonly string[]): Record<string, true> {
  const record: Record<string, true> = {};
  for (const path of paths) {
    const normalized = normalizeWorktreePath(path);
    if (!normalized) {
      continue;
    }
    record[normalized] = true;
  }
  return record;
}

export const useWorktreeTerminalPresenceStore = create<WorktreeTerminalPresenceState>((set) => ({
  openWorktreePaths: {},
  replaceOpenWorktrees: (paths) =>
    set((state) => {
      const next = toOpenWorktreePathRecord(paths);
      const currentKeys = Object.keys(state.openWorktreePaths);
      const nextKeys = Object.keys(next);
      if (
        currentKeys.length === nextKeys.length &&
        currentKeys.every((key) => state.openWorktreePaths[key] === next[key])
      ) {
        return state;
      }
      return {
        openWorktreePaths: next,
      };
    }),
  markOpen: (worktreePath) =>
    set((state) => {
      const normalized = normalizeWorktreePath(worktreePath);
      if (!normalized || state.openWorktreePaths[normalized]) {
        return state;
      }
      return {
        openWorktreePaths: {
          ...state.openWorktreePaths,
          [normalized]: true,
        },
      };
    }),
  clearAll: () =>
    set((state) => {
      if (Object.keys(state.openWorktreePaths).length === 0) {
        return state;
      }
      return {
        openWorktreePaths: {},
      };
    }),
}));
