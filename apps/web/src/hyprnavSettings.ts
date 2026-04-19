import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import type {
  EnvironmentId,
  ProjectHyprnavAction,
  ProjectHyprnavBinding,
  ProjectHyprnavSettings,
} from "@t3tools/contracts";
import type { Project, Thread, ThreadShell } from "./types";

export const HYPRNAV_ACTION_ROWS: ReadonlyArray<{
  key: ProjectHyprnavAction;
  label: string;
}> = [
  { key: "worktree-terminal", label: "Worktree terminal" },
  { key: "open-favorite-editor", label: "Open favorite editor" },
  { key: "shell-command", label: "Shell command" },
] as const;

export function findHyprnavActionLabel(action: ProjectHyprnavAction): string {
  return HYPRNAV_ACTION_ROWS.find((row) => row.key === action)?.label ?? action;
}

export function validateProjectHyprnavSettings(settings: ProjectHyprnavSettings): {
  duplicateSlots: number[];
  emptyShellCommandBindingIds: string[];
} {
  const seen = new Set<number>();
  const duplicateSlots = new Set<number>();
  const emptyShellCommandBindingIds: string[] = [];

  for (const binding of settings.bindings) {
    if (seen.has(binding.slot)) {
      duplicateSlots.add(binding.slot);
    } else {
      seen.add(binding.slot);
    }
    if (binding.action === "shell-command" && binding.command.trim().length === 0) {
      emptyShellCommandBindingIds.push(binding.id);
    }
  }

  return {
    duplicateSlots: [...duplicateSlots].toSorted((left, right) => left - right),
    emptyShellCommandBindingIds,
  };
}

export function computeRemovedHyprnavSlots(
  previous: ProjectHyprnavSettings | null | undefined,
  next: ProjectHyprnavSettings,
): number[] {
  if (!previous) {
    return [];
  }

  const nextSlots = new Set(next.bindings.map((binding) => binding.slot));
  return [
    ...new Set(
      previous.bindings.flatMap((binding) => (nextSlots.has(binding.slot) ? [] : [binding.slot])),
    ),
  ].toSorted((left, right) => left - right);
}

export function makeProjectHyprnavShellBinding(input: {
  readonly id: string;
  readonly slot: number;
  readonly command?: string;
}): ProjectHyprnavBinding {
  return {
    id: input.id,
    slot: input.slot,
    action: "shell-command",
    command: input.command ?? "",
  };
}

export interface ProjectHyprnavSyncJob {
  environmentPath: string;
  projectRoot: string;
  hyprnav: ProjectHyprnavSettings;
  clearSlots: number[];
  lock: boolean;
}

export function resolveActiveHyprnavLockTarget(input: {
  localEnvironmentId: EnvironmentId | null | undefined;
  activeThread: Pick<Thread, "environmentId" | "projectId" | "worktreePath"> | null | undefined;
  project: Pick<Project, "environmentId" | "id" | "cwd"> | null | undefined;
}): string | null {
  if (
    !input.localEnvironmentId ||
    !input.activeThread ||
    input.activeThread.environmentId !== input.localEnvironmentId
  ) {
    return null;
  }

  if (
    !input.project ||
    input.project.environmentId !== input.activeThread.environmentId ||
    input.project.id !== input.activeThread.projectId
  ) {
    return null;
  }

  return input.activeThread.worktreePath ?? input.project.cwd;
}

export function buildProjectHyprnavSyncJobs(input: {
  localEnvironmentId: EnvironmentId;
  projects: readonly Project[];
  threadShells: readonly ThreadShell[];
  activeThread: Pick<Thread, "environmentId" | "projectId" | "worktreePath"> | null | undefined;
  clearSlotsByProjectKey: ReadonlyMap<string, readonly number[]>;
}): ProjectHyprnavSyncJob[] {
  const localProjectsByKey = new Map(
    input.projects
      .filter((project) => project.environmentId === input.localEnvironmentId)
      .map(
        (project) =>
          [scopedProjectKey(scopeProjectRef(project.environmentId, project.id)), project] as const,
      ),
  );
  const jobsByEnvironmentPath = new Map<string, ProjectHyprnavSyncJob>();

  const addJob = (jobInput: {
    environmentPath: string;
    projectKey: string;
    projectRoot: string;
    hyprnav: ProjectHyprnavSettings;
    lock: boolean;
  }) => {
    const clearSlots = [...(input.clearSlotsByProjectKey.get(jobInput.projectKey) ?? [])];
    const existing = jobsByEnvironmentPath.get(jobInput.environmentPath);
    if (existing) {
      existing.lock = existing.lock || jobInput.lock;
      existing.hyprnav = jobInput.hyprnav;
      existing.clearSlots = [...new Set([...existing.clearSlots, ...clearSlots])].toSorted(
        (left, right) => left - right,
      );
      return;
    }

    jobsByEnvironmentPath.set(jobInput.environmentPath, {
      environmentPath: jobInput.environmentPath,
      projectRoot: jobInput.projectRoot,
      hyprnav: jobInput.hyprnav,
      clearSlots,
      lock: jobInput.lock,
    });
  };

  for (const thread of input.threadShells) {
    if (thread.environmentId !== input.localEnvironmentId || thread.worktreePath === null) {
      continue;
    }
    const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const project = localProjectsByKey.get(projectKey);
    if (!project) {
      continue;
    }
    addJob({
      environmentPath: thread.worktreePath,
      projectKey,
      projectRoot: project.cwd,
      hyprnav: project.hyprnav,
      lock: false,
    });
  }

  const activeThread = input.activeThread;
  if (activeThread && activeThread.environmentId === input.localEnvironmentId) {
    const projectKey = scopedProjectKey(
      scopeProjectRef(activeThread.environmentId, activeThread.projectId),
    );
    const project = localProjectsByKey.get(projectKey);
    if (project) {
      addJob({
        environmentPath: activeThread.worktreePath ?? project.cwd,
        projectKey,
        projectRoot: project.cwd,
        hyprnav: project.hyprnav,
        lock: true,
      });
    }
  }

  return [...jobsByEnvironmentPath.values()];
}
