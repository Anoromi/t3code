import fuzzysort from "fuzzysort";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { getThreadRecencyAt } from "../threadRecency";
import type { Project, Thread } from "../types";

export const RECENT_THREAD_LIMIT = 12;
export const SEARCH_RESULT_LIMIT = 20;

export interface NavigationCommandThreadItem {
  type: "thread";
  id: ThreadId;
  projectId: ProjectId;
  title: string;
  projectName: string;
  projectCwd: string;
  branch: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
  recencyAt: string;
}

export interface NavigationCommandProjectItem {
  type: "project";
  id: ProjectId;
  name: string;
  cwd: string;
  hasDraft: boolean;
  latestThreadRecencyAt: string | null;
}

export type NavigationCommandItem = NavigationCommandThreadItem | NavigationCommandProjectItem;

export interface NavigationCommandResults {
  items: NavigationCommandItem[];
}

interface NavigationCommandInput {
  query: string;
  projects: readonly Project[];
  threads: readonly Thread[];
  draftProjectIds: ReadonlySet<ProjectId>;
}

interface ThreadSearchCandidate {
  item: NavigationCommandThreadItem;
  searchableTitle: string;
  searchableProjectName: string;
  searchableProjectCwd: string;
  searchableBranch: string;
  searchableWorktreePath: string;
}

interface ProjectSearchCandidate {
  item: NavigationCommandProjectItem;
  searchableName: string;
  searchableCwd: string;
}

type SearchCandidate = ThreadSearchCandidate | ProjectSearchCandidate;

function isThreadSearchCandidate(candidate: SearchCandidate): candidate is ThreadSearchCandidate {
  return candidate.item.type === "thread";
}

function compareIsoDesc(a: string | null, b: string | null): number {
  const aTime = a ? Date.parse(a) : Number.NEGATIVE_INFINITY;
  const bTime = b ? Date.parse(b) : Number.NEGATIVE_INFINITY;
  return bTime - aTime;
}

function compareThreadRecency(
  a: Pick<NavigationCommandThreadItem, "recencyAt" | "createdAt" | "id">,
  b: Pick<NavigationCommandThreadItem, "recencyAt" | "createdAt" | "id">,
): number {
  const byRecencyAt = compareIsoDesc(a.recencyAt, b.recencyAt);
  if (byRecencyAt !== 0) return byRecencyAt;

  const byCreatedAt = compareIsoDesc(a.createdAt, b.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;

  return String(b.id).localeCompare(String(a.id));
}

function candidateUpdatedAt(candidate: NavigationCommandItem): string | null {
  return candidate.type === "thread" ? candidate.recencyAt : candidate.latestThreadRecencyAt;
}

function candidateSearchPrimary(candidate: SearchCandidate): string {
  return isThreadSearchCandidate(candidate) ? candidate.searchableTitle : candidate.searchableName;
}

function candidateSearchSecondary(candidate: SearchCandidate): string {
  return isThreadSearchCandidate(candidate)
    ? candidate.searchableProjectName
    : candidate.searchableCwd;
}

function candidateSearchTertiary(candidate: SearchCandidate): string {
  return isThreadSearchCandidate(candidate)
    ? candidate.searchableProjectCwd
    : candidate.searchableName;
}

function candidateSearchQuaternary(candidate: SearchCandidate): string {
  return isThreadSearchCandidate(candidate) ? candidate.searchableBranch : candidate.searchableCwd;
}

function candidateSearchQuinary(candidate: SearchCandidate): string {
  return isThreadSearchCandidate(candidate) ? candidate.searchableWorktreePath : "";
}

function fuzzyResultEntryScore(result: Fuzzysort.KeysResult<SearchCandidate>): number {
  const item = result.obj.item;
  const primaryScore = result[0]?.score ?? 0;
  const secondaryScore = result[1]?.score ?? 0;
  const tertiaryScore = result[2]?.score ?? 0;
  const quaternaryScore = result[3]?.score ?? 0;
  const quinaryScore = result[4]?.score ?? 0;

  if (item.type === "thread") {
    return (
      result.score +
      primaryScore * 0.32 +
      secondaryScore * 0.14 +
      tertiaryScore * 0.08 +
      quaternaryScore * 0.05 +
      quinaryScore * 0.05
    );
  }

  return result.score + primaryScore * 0.36 + secondaryScore * 0.12;
}

export function getProjectCommandActionLabel(hasDraft: boolean): string {
  return hasDraft ? "Open draft" : "New thread";
}

export function buildNavigationCommandResults(
  input: NavigationCommandInput,
): NavigationCommandResults {
  const query = input.query.trim();
  const projectById = new Map(input.projects.map((project) => [project.id, project] as const));
  const latestThreadRecencyAtByProjectId = new Map<ProjectId, string>();

  for (const thread of input.threads) {
    const threadRecencyAt = getThreadRecencyAt(thread);
    const current = latestThreadRecencyAtByProjectId.get(thread.projectId) ?? null;
    if (compareIsoDesc(threadRecencyAt, current) >= 0) {
      continue;
    }
    latestThreadRecencyAtByProjectId.set(thread.projectId, threadRecencyAt);
  }

  const threadItems = input.threads
    .map((thread): NavigationCommandThreadItem | null => {
      const project = projectById.get(thread.projectId);
      if (!project) return null;

      return {
        type: "thread",
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        projectName: project.name,
        projectCwd: project.cwd,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt ?? thread.createdAt,
        recencyAt: getThreadRecencyAt(thread),
      };
    })
    .filter((thread): thread is NavigationCommandThreadItem => thread !== null);

  if (query.length === 0) {
    return {
      items: threadItems.toSorted(compareThreadRecency).slice(0, RECENT_THREAD_LIMIT),
    };
  }

  const searchCandidates: SearchCandidate[] = [
    ...threadItems.map((thread) => ({
      item: thread,
      searchableTitle: thread.title,
      searchableProjectName: thread.projectName,
      searchableProjectCwd: thread.projectCwd,
      searchableBranch: thread.branch ?? "",
      searchableWorktreePath: thread.worktreePath ?? "",
    })),
    ...input.projects.map((project) => ({
      item: {
        type: "project" as const,
        id: project.id,
        name: project.name,
        cwd: project.cwd,
        hasDraft: input.draftProjectIds.has(project.id),
        latestThreadRecencyAt: latestThreadRecencyAtByProjectId.get(project.id) ?? null,
      },
      searchableName: project.name,
      searchableCwd: project.cwd,
    })),
  ];

  const results = fuzzysort.go(query, searchCandidates, {
    limit: SEARCH_RESULT_LIMIT,
    threshold: 0.15,
    keys: [
      candidateSearchPrimary,
      candidateSearchSecondary,
      candidateSearchTertiary,
      candidateSearchQuaternary,
      candidateSearchQuinary,
    ],
    scoreFn: fuzzyResultEntryScore,
  });

  return {
    items: [...results]
      .toSorted((a, b) => {
        const byScore = b.score - a.score;
        if (byScore !== 0) return byScore;

        const byUpdatedAt = compareIsoDesc(
          candidateUpdatedAt(a.obj.item),
          candidateUpdatedAt(b.obj.item),
        );
        if (byUpdatedAt !== 0) return byUpdatedAt;

        if (a.obj.item.type !== b.obj.item.type) {
          return a.obj.item.type === "project" ? -1 : 1;
        }

        return a.obj.item.type === "thread"
          ? a.obj.item.title.localeCompare((b.obj.item as NavigationCommandThreadItem).title)
          : a.obj.item.name.localeCompare((b.obj.item as NavigationCommandProjectItem).name);
      })
      .map((result) => result.obj.item),
  };
}
