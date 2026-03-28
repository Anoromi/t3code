import type { GitBranch, NativeApi } from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateGitQueries } from "./gitReactQuery";
import {
  type EnvMode,
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
} from "../components/BranchToolbar.logic";

export function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export async function applyGitBranchSelection(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  api: NativeApi;
  branch: GitBranch;
  branchCwd: string;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  onSetThreadBranch: (branch: string | null, worktreePath: string | null) => void;
  onSetOptimisticBranch?: (branch: string | null) => void;
  onBranchActionError?: (title: string, description: string) => void;
  queryClient: QueryClient;
}): Promise<boolean> {
  const isSelectingWorktreeBase =
    input.effectiveEnvMode === "worktree" && !input.envLocked && !input.activeWorktreePath;

  if (isSelectingWorktreeBase) {
    input.onSetThreadBranch(input.branch.name, null);
    return true;
  }

  const selectionTarget = resolveBranchSelectionTarget({
    activeProjectCwd: input.activeProjectCwd,
    activeWorktreePath: input.activeWorktreePath,
    branch: input.branch,
  });

  if (selectionTarget.reuseExistingWorktree) {
    input.onSetThreadBranch(input.branch.name, selectionTarget.nextWorktreePath);
    return true;
  }

  const selectedBranchName = input.branch.isRemote
    ? deriveLocalBranchNameFromRemoteRef(input.branch.name)
    : input.branch.name;
  input.onSetOptimisticBranch?.(selectedBranchName);

  try {
    await input.api.git.checkout({
      cwd: selectionTarget.checkoutCwd,
      branch: input.branch.name,
    });
  } catch (error) {
    input.onBranchActionError?.("Failed to checkout branch.", toBranchActionErrorMessage(error));
    return false;
  }

  let nextBranchName = selectedBranchName;
  if (input.branch.isRemote) {
    const status = await input.api.git.status({ cwd: input.branchCwd }).catch(() => null);
    if (status?.branch) {
      nextBranchName = status.branch;
    }
  }

  input.onSetOptimisticBranch?.(nextBranchName);
  input.onSetThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
  await invalidateGitQueries(input.queryClient).catch(() => undefined);
  return true;
}
