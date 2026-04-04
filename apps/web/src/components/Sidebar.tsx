import {
  ArrowLeftIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GitForkIcon,
  GitPullRequestIcon,
  PlusIcon,
  RocketIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { autoAnimate } from "@formkit/auto-animate";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  ProjectId,
  ThreadId,
  type GitStatusResult,
} from "@t3tools/contracts";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { Schema } from "effect";
import { isElectron } from "../env";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { cn, isLinuxPlatform, isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { shortcutLabelForCommand } from "../keybindings";
import { formatRelativeTime } from "../relativeTime";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldHighlightDesktopUpdateError,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent } from "./ui/collapsible";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import type { Project, Thread } from "../types";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  buildSidebarProjectTree,
  buildSidebarProjectThreadEntries,
  detectWorktreeGroupBirths,
  flattenSidebarProjectThreadIds,
  getFallbackThreadIdAfterDelete,
  getProjectSortTimestamp,
  getThreadSortTimestamp,
  orderItemsByPreferredIds,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldDisableWorktreeTitleRegenerate,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  type SidebarProjectThreadEntry,
} from "./Sidebar.logic";
import type { SidebarWorktreeGroupEntry } from "./Sidebar.logic";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

const THREAD_PREVIEW_LIMIT = 6;
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const loadedProjectFaviconSrcs = new Set<string>();
const COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY = "sidebar_collapsed_worktree_groups";
const WORKTREE_GROUP_BIRTH_DURATION_MS = 800;
const WORKTREE_GROUP_FLIP_DURATION_MS = 260;
const WORKTREE_GROUP_FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const SIDEBAR_NESTED_CARD_CLASS_NAME =
  "mt-1.5 ml-2 rounded-xl border border-border/40 bg-sidebar-accent/20 px-1 py-1";
const SIDEBAR_NESTED_CARD_HEADER_CLASS_NAME =
  "gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent";
const SIDEBAR_NESTED_CARD_CONTENT_CLASS_NAME =
  "mx-0 translate-x-0 border-t border-border/50 px-1.5 py-1";

interface ProjectSidebarSection {
  hasHiddenThreadEntries: boolean;
  isProjectExpanded: boolean;
  isThreadListExpanded: boolean;
  orderedProjectThreadIds: ThreadId[];
  project: Project;
  projectStatus: ReturnType<typeof resolveProjectStatusIndicator>;
  projectThreadEntries: SidebarProjectThreadEntry[];
  projectThreads: Thread[];
  visibleThreadEntries: SidebarProjectThreadEntry[];
  visibleSelectableThreadEntries: SidebarProjectThreadEntry[];
}

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0 text-foreground"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Derives the server's HTTP origin (scheme + host + port) from the same
 * sources WsTransport uses, converting ws(s) to http(s).
 */
function getServerHttpOrigin(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  // Parse to extract just the origin, dropping path/query (e.g. ?token=…)
  const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  try {
    return new URL(httpUrl).origin;
  } catch {
    return httpUrl;
  }
}

const serverHttpOrigin = getServerHttpOrigin();

function ProjectFavicon({ cwd }: { cwd: string }) {
  const src = `${serverHttpOrigin}/api/project-favicon?cwd=${encodeURIComponent(cwd)}`;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  if (status === "error") {
    return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/50" />;
  }

  return (
    <img
      src={src}
      alt=""
      className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loading" ? "hidden" : ""}`}
      onLoad={() => {
        loadedProjectFaviconSrcs.add(src);
        setStatus("loaded");
      }}
      onError={() => setStatus("error")}
    />
  );
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: ProjectId;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const navigate = useNavigate();
  const isOnSettings = useLocation({ select: (loc) => loc.pathname === "/settings" });
  const appSettings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { handleNewThread } = useHandleNewThread();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const keybindings = useServerKeybindings();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const [collapsedWorktreeGroupKeys, setCollapsedWorktreeGroupKeys] = useLocalStorage(
    COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
    [],
    Schema.Array(Schema.String),
  );
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [animatingGroupKeys, setAnimatingGroupKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const hasCapturedVisibleEntriesRef = useRef(false);
  const previousVisibleEntriesByProjectRef = useRef(
    new Map<ProjectId, SidebarProjectThreadEntry[]>(),
  );
  const previousVisibleThreadRectsByProjectRef = useRef(
    new Map<ProjectId, Map<ThreadId, DOMRectReadOnly>>(),
  );
  const groupElementByKeyRef = useRef(new Map<string, HTMLDivElement>());
  const groupAnimationCleanupTimersRef = useRef(new Map<string, number>());
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const prefersReducedMotion = usePrefersReducedMotion();
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const collapsedWorktreeGroupKeySet = useMemo(
    () => new Set(collapsedWorktreeGroupKeys),
    [collapsedWorktreeGroupKeys],
  );
  const threadGitTargets = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, threads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);

  const clearGroupAnimationCleanupTimer = useCallback((groupKey: string) => {
    const existingTimerId = groupAnimationCleanupTimersRef.current.get(groupKey);
    if (existingTimerId !== undefined) {
      window.clearTimeout(existingTimerId);
      groupAnimationCleanupTimersRef.current.delete(groupKey);
    }
  }, []);

  const scheduleGroupAnimationCleanup = useCallback(
    (groupKey: string) => {
      clearGroupAnimationCleanupTimer(groupKey);
      const timerId = window.setTimeout(() => {
        groupAnimationCleanupTimersRef.current.delete(groupKey);
        setAnimatingGroupKeys((current) => {
          if (!current.has(groupKey)) {
            return current;
          }
          const next = new Set(current);
          next.delete(groupKey);
          return next;
        });
      }, WORKTREE_GROUP_BIRTH_DURATION_MS);
      groupAnimationCleanupTimersRef.current.set(groupKey, timerId);
    },
    [clearGroupAnimationCleanupTimer],
  );

  const registerWorktreeGroupElement = useCallback(
    (groupKey: string, element: HTMLDivElement | null) => {
      if (element) {
        groupElementByKeyRef.current.set(groupKey, element);
      } else {
        groupElementByKeyRef.current.delete(groupKey);
      }
    },
    [],
  );

  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: (project) => project.id,
      }),
    [projectOrder, projects],
  );

  const isProjectExpanded = useCallback(
    (projectId: ProjectId) => projectExpandedById[projectId] ?? true,
    [projectExpandedById],
  );

  const projectSidebarSections = useMemo<ProjectSidebarSection[]>(
    () =>
      orderedProjects.map((project) => {
        const projectThreads = threads
          .filter((thread) => thread.projectId === project.id)
          .toSorted((a, b) => {
            const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            if (byDate !== 0) return byDate;
            return b.id.localeCompare(a.id);
          });
        const projectExpanded = isProjectExpanded(project.id);
        const projectStatus = resolveProjectStatusIndicator(
          projectThreads.map((thread) =>
            resolveThreadStatusPill({
              thread: {
                ...thread,
                lastVisitedAt: threadLastVisitedAtById[thread.id],
              },
              hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
              hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
            }),
          ),
        );
        const projectThreadEntries = buildSidebarProjectThreadEntries(project, projectThreads);
        const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
        const hasHiddenThreadEntries = projectThreadEntries.length > THREAD_PREVIEW_LIMIT;
        const visibleThreadEntries =
          hasHiddenThreadEntries && !isThreadListExpanded
            ? projectThreadEntries.slice(0, THREAD_PREVIEW_LIMIT)
            : projectThreadEntries;
        const visibleSelectableThreadEntries = visibleThreadEntries.reduce<
          SidebarProjectThreadEntry[]
        >((entries, entry) => {
          if (entry.kind === "thread" || !collapsedWorktreeGroupKeySet.has(entry.groupKey)) {
            entries.push(entry);
          }
          return entries;
        }, []);

        return {
          hasHiddenThreadEntries,
          isProjectExpanded: projectExpanded,
          isThreadListExpanded,
          orderedProjectThreadIds: flattenSidebarProjectThreadIds(visibleSelectableThreadEntries),
          project,
          projectStatus,
          projectThreadEntries,
          projectThreads,
          visibleThreadEntries,
          visibleSelectableThreadEntries,
        } satisfies ProjectSidebarSection;
      }),
    [
      collapsedWorktreeGroupKeySet,
      expandedThreadListsByProject,
      isProjectExpanded,
      orderedProjects,
      threadLastVisitedAtById,
      threads,
    ],
  );

  useLayoutEffect(() => {
    const currentVisibleEntriesByProject = new Map<ProjectId, SidebarProjectThreadEntry[]>();
    const currentVisibleThreadRectsByProject = new Map<ProjectId, Map<ThreadId, DOMRectReadOnly>>();

    const getTopLevelThreadElement = (threadId: ThreadId): HTMLElement | null => {
      const escapedThreadId =
        typeof window !== "undefined" &&
        typeof window.CSS !== "undefined" &&
        typeof window.CSS.escape === "function"
          ? window.CSS.escape(String(threadId))
          : String(threadId);
      return document.querySelector<HTMLElement>(
        `[data-sidebar-top-level-thread-id="${escapedThreadId}"]`,
      );
    };

    for (const section of projectSidebarSections) {
      currentVisibleEntriesByProject.set(section.project.id, section.visibleThreadEntries);

      const threadRects = new Map<ThreadId, DOMRectReadOnly>();
      for (const entry of section.visibleThreadEntries) {
        if (entry.kind !== "thread") {
          continue;
        }

        const element = getTopLevelThreadElement(entry.thread.id);
        if (!element) {
          continue;
        }

        threadRects.set(entry.thread.id, element.getBoundingClientRect());
      }

      currentVisibleThreadRectsByProject.set(section.project.id, threadRects);
    }

    if (!hasCapturedVisibleEntriesRef.current) {
      previousVisibleEntriesByProjectRef.current = currentVisibleEntriesByProject;
      previousVisibleThreadRectsByProjectRef.current = currentVisibleThreadRectsByProject;
      hasCapturedVisibleEntriesRef.current = true;
      return;
    }

    const nextAnimatingGroupKeys: string[] = [];
    for (const section of projectSidebarSections) {
      const previousEntries =
        previousVisibleEntriesByProjectRef.current.get(section.project.id) ?? [];
      const births = detectWorktreeGroupBirths(previousEntries, section.visibleThreadEntries);
      if (!section.isProjectExpanded || births.length === 0) {
        continue;
      }

      const previousThreadRects =
        previousVisibleThreadRectsByProjectRef.current.get(section.project.id) ?? new Map();

      for (const birth of births) {
        const groupElement = groupElementByKeyRef.current.get(birth.groupKey);
        if (!groupElement) {
          continue;
        }

        nextAnimatingGroupKeys.push(birth.groupKey);
        scheduleGroupAnimationCleanup(birth.groupKey);

        if (prefersReducedMotion) {
          continue;
        }

        const previousRect = previousThreadRects.get(birth.sourceThreadId);
        const currentRect = groupElement.getBoundingClientRect();
        if (!previousRect || currentRect.height <= 0) {
          continue;
        }

        const deltaY = previousRect.top - currentRect.top;
        const scaleY = previousRect.height > 0 ? previousRect.height / currentRect.height : 1;
        groupElement.animate(
          [
            {
              opacity: 0.96,
              transform: `translateY(${deltaY}px) scaleY(${scaleY})`,
              transformOrigin: "top center",
            },
            {
              opacity: 1,
              transform: "translateY(0px) scaleY(1)",
              transformOrigin: "top center",
            },
          ],
          {
            duration: WORKTREE_GROUP_FLIP_DURATION_MS,
            easing: WORKTREE_GROUP_FLIP_EASING,
            fill: "both",
          },
        );
      }
    }

    if (nextAnimatingGroupKeys.length > 0) {
      setAnimatingGroupKeys((current) => {
        const next = new Set(current);
        for (const groupKey of nextAnimatingGroupKeys) {
          next.add(groupKey);
        }
        return next;
      });
    }

    previousVisibleEntriesByProjectRef.current = currentVisibleEntriesByProject;
    previousVisibleThreadRectsByProjectRef.current = currentVisibleThreadRectsByProject;
  }, [prefersReducedMotion, projectSidebarSections, scheduleGroupAnimationCleanup]);

  useEffect(
    () => () => {
      for (const timerId of groupAnimationCleanupTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      groupAnimationCleanupTimersRef.current.clear();
    },
    [],
  );

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = sortThreadsForSidebar(
        threads.filter((thread) => thread.projectId === projectId),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [appSettings.sidebarThreadSortOrder, navigate, threads],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt,
        });
        await handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
          codexFastMode: appSettings.defaultCodexFastMode,
          codexReasoningEffort: appSettings.defaultCodexReasoningEffort,
        }).catch(() => undefined);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
      appSettings.defaultCodexFastMode,
      appSettings.defaultCodexReasoningEffort,
      appSettings.defaultThreadEnvMode,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  /**
   * Delete a single thread: stop session, close terminal, dispatch delete,
   * clean up drafts/state, and optionally remove orphaned worktree.
   * Callers handle thread-level confirmation; this still prompts for worktree removal.
   */
  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: { deletedThreadIds?: ReadonlySet<ThreadId> } = {},
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      const threadProject = projects.find((project) => project.id === thread.projectId);
      // When bulk-deleting, exclude the other threads being deleted so
      // getOrphanedWorktreePathForThread correctly detects that no surviving
      // threads will reference this worktree.
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((t) => t.id === threadId || !deletedIds.has(t.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed
      }

      const allDeletedIds = deletedIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadId,
        deletedThreadIds: allDeletedIds,
        sortOrder: appSettings.sidebarThreadSortOrder,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);
      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      appSettings.sidebarThreadSortOrder,
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      navigate,
      projects,
      removeWorktreeMutation,
      routeThreadId,
      threads,
    ],
  );

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      const threadWorkspacePath =
        thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId, { threadId });
        return;
      }
      if (clicked !== "delete") return;
      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      await deleteThread(threadId);
    },
    [
      appSettings.confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      projectCwdById,
      threads,
    ],
  );

  const handleWorktreeGroupContextMenu = useCallback(
    async (
      projectId: ProjectId,
      input: {
        worktreePath: string;
        worktreeTitleStatus: "pending" | "ready" | "failed" | "absent";
        worktreeTitleUpdatedAt: string | null;
      },
      position: { x: number; y: number },
    ) => {
      const api = readNativeApi();
      if (!api) return;

      const regenerateDisabled = shouldDisableWorktreeTitleRegenerate({
        worktreeTitleStatus: input.worktreeTitleStatus,
        worktreeTitleUpdatedAt: input.worktreeTitleUpdatedAt,
        nowMs: Date.now(),
      });

      const clicked = await api.contextMenu.show(
        [
          {
            id: "regenerate-title",
            label: "Regenerate title",
            disabled: regenerateDisabled,
          },
        ],
        position,
      );
      if (clicked !== "regenerate-title") return;

      try {
        await api.orchestration.dispatchCommand({
          type: "project.worktree-group-title.regenerate",
          commandId: newCommandId(),
          projectId,
          worktreePath: input.worktreePath,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to regenerate worktree title",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          const thread = threads.find((candidate) => candidate.id === id);
          markThreadUnread(id, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
      threads,
    ],
  );

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [{ id: "delete", label: "Remove project", destructive: true }],
        position,
      );
      if (clicked !== "delete") return;

      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const projectThreads = threads.filter((thread) => thread.projectId === projectId);
      if (projectThreads.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all threads in this project before removing it.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(`Remove project "${project.name}"?`);
      if (!confirmed) return;

      try {
        const projectDraftThread = getDraftThreadByProjectId(projectId);
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
        }
        clearProjectDraftThreadId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${project.name}"`,
          description: message,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      getDraftThreadByProjectId,
      projects,
      threads,
    ],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = orderedProjects.find((project) => project.id === active.id);
      const overProject = orderedProjects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [appSettings.sidebarProjectSortOrder, orderedProjects, reorderProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  }, []);

  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const sortedProjects = useMemo(
    () => sortProjectsForSidebar(projects, threads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, projects, threads],
  );
  const sortedProjectTree = useMemo(
    () => buildSidebarProjectTree(sortedProjects),
    [sortedProjects],
  );
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
  const routeThreadProjectId = useMemo(
    () => threads.find((thread) => thread.id === routeThreadId)?.projectId ?? null,
    [routeThreadId, threads],
  );

  function renderProjectItem(
    projectNode: (typeof sortedProjectTree)[number],
    dragHandleProps: SortableProjectHandleProps | null,
    nested = false,
  ) {
    const { childProjects, displayName, project } = projectNode;
    const projectExpanded = isProjectExpanded(project.id);
    const projectThreads = sortThreadsForSidebar(
      threads.filter((thread) => thread.projectId === project.id),
      appSettings.sidebarThreadSortOrder,
    );
    const projectStatus = resolveProjectStatusIndicator(
      projectThreads.map((thread) =>
        resolveThreadStatusPill({
          thread: {
            ...thread,
            lastVisitedAt: threadLastVisitedAtById[thread.id],
          },
          hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
          hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
        }),
      ),
    );
    const activeThreadId = routeThreadId ?? undefined;
    const projectThreadEntries = buildSidebarProjectThreadEntries(project, projectThreads);
    const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
    const pinnedCollapsedThread =
      !projectExpanded && activeThreadId
        ? (projectThreads.find((thread) => thread.id === activeThreadId) ?? null)
        : null;
    const hasExpandedChildProject = childProjects.some((childProject) =>
      isProjectExpanded(childProject.project.id),
    );
    const hasActiveChildProject =
      routeThreadProjectId !== null &&
      childProjects.some((childProject) => childProject.project.id === routeThreadProjectId);
    const shouldShowThreadPanel =
      projectExpanded ||
      pinnedCollapsedThread !== null ||
      hasExpandedChildProject ||
      hasActiveChildProject;
    const hasHiddenThreadEntries = projectThreadEntries.length > THREAD_PREVIEW_LIMIT;
    const visibleThreadEntries = pinnedCollapsedThread
      ? [
          {
            kind: "thread" as const,
            positionCreatedAt: pinnedCollapsedThread.createdAt,
            thread: pinnedCollapsedThread,
          },
        ]
      : hasHiddenThreadEntries && !isThreadListExpanded
        ? projectThreadEntries.slice(0, THREAD_PREVIEW_LIMIT)
        : projectThreadEntries;
    const visibleSelectableThreadEntries = visibleThreadEntries.reduce<typeof visibleThreadEntries>(
      (entries, entry) => {
        if (entry.kind === "thread" || !collapsedWorktreeGroupKeySet.has(entry.groupKey)) {
          entries.push(entry);
        }
        return entries;
      },
      [],
    );
    const orderedProjectThreadIds = flattenSidebarProjectThreadIds(visibleSelectableThreadEntries);
    const childProjectThreadsByProjectId = new Map(
      childProjects.map((childProject) => [
        childProject.project.id,
        sortThreadsForSidebar(
          threads.filter((thread) => thread.projectId === childProject.project.id),
          appSettings.sidebarThreadSortOrder,
        ),
      ]),
    );
    type OrderedProjectContentEntry =
      | {
          type: "thread";
          thread: (typeof projectThreads)[number];
          sortTimestamp: number;
          orderIndex: number;
        }
      | {
          type: "worktreeGroup";
          worktreeGroup: SidebarWorktreeGroupEntry;
          sortTimestamp: number;
          orderIndex: number;
        }
      | {
          type: "childProject";
          childProject: (typeof childProjects)[number];
          sortTimestamp: number;
          orderIndex: number;
        };

    const orderedProjectContent: OrderedProjectContentEntry[] = [
      ...visibleThreadEntries.map(
        (entry, index): OrderedProjectContentEntry =>
          entry.kind === "thread"
            ? {
                type: "thread",
                thread: entry.thread,
                sortTimestamp: getThreadSortTimestamp(
                  entry.thread,
                  appSettings.sidebarThreadSortOrder,
                ),
                orderIndex: index,
              }
            : {
                type: "worktreeGroup",
                worktreeGroup: entry,
                sortTimestamp: Number.isFinite(Date.parse(entry.positionCreatedAt))
                  ? Date.parse(entry.positionCreatedAt)
                  : Number.NEGATIVE_INFINITY,
                orderIndex: index,
              },
      ),
      ...childProjects.map(
        (childProject, index): OrderedProjectContentEntry => ({
          type: "childProject",
          childProject,
          sortTimestamp: getProjectSortTimestamp(
            childProject.project,
            childProjectThreadsByProjectId.get(childProject.project.id) ?? [],
            appSettings.sidebarThreadSortOrder,
          ),
          orderIndex: visibleThreadEntries.length + index,
        }),
      ),
    ].toSorted((left, right) => {
      const byTimestamp =
        right.sortTimestamp === left.sortTimestamp
          ? 0
          : right.sortTimestamp > left.sortTimestamp
            ? 1
            : -1;
      if (byTimestamp !== 0) {
        return byTimestamp;
      }
      return left.orderIndex - right.orderIndex;
    });

    const projectContent = (
      <Collapsible className="group/collapsible" open={shouldShowThreadPanel}>
        <div className="group/project-header relative">
          <SidebarMenuButton
            ref={
              !nested && isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined
            }
            size="sm"
            className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
              !nested && isManualProjectSorting
                ? "cursor-grab active:cursor-grabbing"
                : "cursor-pointer"
            } ${nested ? "rounded-lg" : ""}`}
            {...(!nested && isManualProjectSorting && dragHandleProps
              ? dragHandleProps.attributes
              : {})}
            {...(!nested && isManualProjectSorting && dragHandleProps
              ? dragHandleProps.listeners
              : {})}
            onPointerDownCapture={handleProjectTitlePointerDownCapture}
            onClick={(event) => handleProjectTitleClick(event, project.id)}
            onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              void handleProjectContextMenu(project.id, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            {!projectExpanded && projectStatus ? (
              <span
                aria-hidden="true"
                title={projectStatus.label}
                className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
              >
                <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                  <span
                    className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                      projectStatus.pulse ? "animate-pulse" : ""
                    }`}
                  />
                </span>
                <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
              </span>
            ) : (
              <ChevronRightIcon
                className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                  projectExpanded ? "rotate-90" : ""
                }`}
              />
            )}
            <ProjectFavicon cwd={project.cwd} />
            <span className="flex-1 truncate text-xs font-medium text-foreground/90">
              {displayName}
            </span>
          </SidebarMenuButton>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  render={
                    <button
                      type="button"
                      aria-label={`Create new thread in ${displayName}`}
                      data-testid="new-thread-button"
                    />
                  }
                  showOnHover
                  className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleNewThread(project.id, {
                      envMode: resolveSidebarNewThreadEnvMode({
                        defaultEnvMode: appSettings.defaultThreadEnvMode,
                      }),
                      codexFastMode: appSettings.defaultCodexFastMode,
                      codexReasoningEffort: appSettings.defaultCodexReasoningEffort,
                    });
                  }}
                >
                  <SquarePenIcon className="size-3.5" />
                </SidebarMenuAction>
              }
            />
            <TooltipPopup side="top">
              {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
            </TooltipPopup>
          </Tooltip>
        </div>

        <CollapsibleContent>
          <SidebarMenuSub
            ref={attachThreadListAutoAnimateRef}
            className="mx-1 my-0 w-full translate-x-0 gap-0.5 px-1.5 py-0"
          >
            {orderedProjectContent.map((entry) =>
              entry.type === "thread" ? (
                renderThreadRow(entry.thread, orderedProjectThreadIds, {
                  topLevelDataThreadId: entry.thread.id,
                })
              ) : entry.type === "worktreeGroup" ? (
                <SidebarMenuSubItem
                  key={entry.worktreeGroup.groupKey}
                  className="w-full"
                  data-thread-selection-safe
                >
                  <Collapsible
                    className="w-full"
                    open={!collapsedWorktreeGroupKeySet.has(entry.worktreeGroup.groupKey)}
                    onOpenChange={(open) => {
                      setWorktreeGroupCollapsed(entry.worktreeGroup.groupKey, !open);
                    }}
                  >
                    <div
                      ref={(element) => {
                        registerWorktreeGroupElement(entry.worktreeGroup.groupKey, element);
                      }}
                      data-worktree-group-key={entry.worktreeGroup.groupKey}
                      className={cn(
                        "overflow-hidden",
                        SIDEBAR_NESTED_CARD_CLASS_NAME,
                        animatingGroupKeys.has(entry.worktreeGroup.groupKey)
                          ? "sidebar-worktree-group-born"
                          : "",
                      )}
                    >
                      <SidebarMenuButton
                        render={<button type="button" />}
                        size="sm"
                        className={SIDEBAR_NESTED_CARD_HEADER_CLASS_NAME}
                        data-thread-selection-safe
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void handleWorktreeGroupContextMenu(
                            project.id,
                            {
                              worktreePath: entry.worktreeGroup.worktreePath,
                              worktreeTitleStatus: entry.worktreeGroup.worktreeTitleStatus,
                              worktreeTitleUpdatedAt: entry.worktreeGroup.worktreeTitleUpdatedAt,
                            },
                            {
                              x: event.clientX,
                              y: event.clientY,
                            },
                          );
                        }}
                        onClick={() => {
                          setWorktreeGroupCollapsed(
                            entry.worktreeGroup.groupKey,
                            !collapsedWorktreeGroupKeySet.has(entry.worktreeGroup.groupKey),
                          );
                        }}
                      >
                        <ChevronRightIcon
                          className={`size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                            collapsedWorktreeGroupKeySet.has(entry.worktreeGroup.groupKey)
                              ? ""
                              : "rotate-90"
                          }`}
                        />
                        <GitForkIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              entry.worktreeGroup.worktreeTitleStatus === "pending" ? (
                                <Skeleton className="h-3.5 w-28 rounded-full" />
                              ) : (
                                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
                                  {entry.worktreeGroup.label}
                                </span>
                              )
                            }
                          />
                          <TooltipPopup side="top">{entry.worktreeGroup.worktreePath}</TooltipPopup>
                        </Tooltip>
                      </SidebarMenuButton>

                      <CollapsibleContent keepMounted>
                        <SidebarMenuSub className={SIDEBAR_NESTED_CARD_CONTENT_CLASS_NAME}>
                          {entry.worktreeGroup.threads.map((thread, index) =>
                            renderThreadRow(
                              thread,
                              orderedProjectThreadIds,
                              animatingGroupKeys.has(entry.worktreeGroup.groupKey) &&
                                !collapsedWorktreeGroupKeySet.has(entry.worktreeGroup.groupKey) &&
                                !prefersReducedMotion
                                ? {
                                    childAnimationIndex: index,
                                  }
                                : undefined,
                            ),
                          )}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                </SidebarMenuSubItem>
              ) : (
                <div key={entry.childProject.project.id} className={SIDEBAR_NESTED_CARD_CLASS_NAME}>
                  {renderProjectItem(entry.childProject, null, true)}
                </div>
              ),
            )}

            {projectExpanded && hasHiddenThreadEntries && !isThreadListExpanded && (
              <SidebarMenuSubItem className="w-full">
                <SidebarMenuSubButton
                  render={<button type="button" />}
                  data-thread-selection-safe
                  size="sm"
                  className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                  onClick={() => {
                    expandThreadListForProject(project.id);
                  }}
                >
                  <span>Show more</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
            {projectExpanded && hasHiddenThreadEntries && isThreadListExpanded && (
              <SidebarMenuSubItem className="w-full">
                <SidebarMenuSubButton
                  render={<button type="button" />}
                  data-thread-selection-safe
                  size="sm"
                  className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                  onClick={() => {
                    collapseThreadListForProject(project.id);
                  }}
                >
                  <span>Show less</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    );

    return projectContent;
  }

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const showDesktopUpdateButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);

  const desktopUpdateTooltip = desktopUpdateState
    ? getDesktopUpdateButtonTooltip(desktopUpdateState)
    : "Update available";

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const desktopUpdateButtonInteractivityClasses = desktopUpdateButtonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:bg-accent hover:text-foreground";
  const desktopUpdateButtonClasses =
    desktopUpdateState?.status === "downloaded"
      ? "text-emerald-500"
      : desktopUpdateState?.status === "downloading"
        ? "text-sky-400"
        : shouldHighlightDesktopUpdateError(desktopUpdateState)
          ? "text-rose-500 animate-pulse"
          : "text-amber-500 animate-pulse";
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal") ??
    shortcutLabelForCommand(keybindings, "chat.new");

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const setWorktreeGroupCollapsed = useCallback(
    (groupKey: string, collapsed: boolean) => {
      setCollapsedWorktreeGroupKeys((currentKeys) => {
        const nextKeys = new Set(currentKeys);
        if (collapsed) {
          nextKeys.add(groupKey);
        } else {
          nextKeys.delete(groupKey);
        }
        return [...nextKeys].toSorted((left, right) => left.localeCompare(right));
      });
    },
    [setCollapsedWorktreeGroupKeys],
  );

  const renderThreadRow = useCallback(
    (
      thread: Thread,
      orderedProjectThreadIds: readonly ThreadId[],
      options?: {
        childAnimationIndex?: number;
        topLevelDataThreadId?: ThreadId;
      },
    ) => {
      const isActive = routeThreadId === thread.id;
      const isSelected = selectedThreadIds.has(thread.id);
      const isHighlighted = isActive || isSelected;
      const threadStatus = resolveThreadStatusPill({
        thread: {
          ...thread,
          lastVisitedAt: threadLastVisitedAtById[thread.id],
        },
        hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
        hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
      });
      const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
      const terminalStatus = terminalStatusFromRunningIds(
        selectThreadTerminalState(terminalStateByThreadId, thread.id).runningTerminalIds,
      );
      const itemStyle: CSSProperties | undefined =
        options?.childAnimationIndex !== undefined
          ? ({
              "--sidebar-group-stagger-index": options.childAnimationIndex,
            } as CSSProperties)
          : undefined;

      return (
        <SidebarMenuSubItem
          key={thread.id}
          className={`w-full ${
            options?.childAnimationIndex !== undefined ? "sidebar-worktree-group-child-enter" : ""
          }`}
          data-thread-item
          data-sidebar-top-level-thread-id={
            options?.topLevelDataThreadId ? String(options.topLevelDataThreadId) : undefined
          }
          data-sidebar-worktree-group-child={
            options?.childAnimationIndex !== undefined ? "true" : undefined
          }
          style={itemStyle}
        >
          <SidebarMenuSubButton
            render={<div role="button" tabIndex={0} />}
            size="sm"
            isActive={isActive}
            className={resolveThreadRowClassName({
              isActive,
              isSelected,
            })}
            onClick={(event) => {
              handleThreadClick(event, thread.id, orderedProjectThreadIds);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (selectedThreadIds.size > 0) {
                clearSelection();
              }
              setSelectionAnchor(thread.id);
              void navigate({
                to: "/$threadId",
                params: { threadId: thread.id },
              });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (selectedThreadIds.size > 0 && selectedThreadIds.has(thread.id)) {
                void handleMultiSelectContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                });
              } else {
                if (selectedThreadIds.size > 0) {
                  clearSelection();
                }
                void handleThreadContextMenu(thread.id, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              {prStatus && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={prStatus.tooltip}
                        className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                        onClick={(event) => {
                          openPrLink(event, prStatus.url);
                        }}
                      >
                        <GitPullRequestIcon className="size-3" />
                      </button>
                    }
                  />
                  <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
                </Tooltip>
              )}
              {threadStatus && (
                <span
                  className={`inline-flex items-center gap-1 text-[10px] ${threadStatus.colorClass}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${threadStatus.dotClass} ${
                      threadStatus.pulse ? "animate-pulse" : ""
                    }`}
                  />
                  <span className="hidden md:inline">{threadStatus.label}</span>
                </span>
              )}
              {renamingThreadId === thread.id ? (
                <input
                  ref={(el) => {
                    if (el && renamingInputRef.current !== el) {
                      renamingInputRef.current = el;
                      el.focus();
                      el.select();
                    }
                  }}
                  className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-xs outline-none"
                  value={renamingTitle}
                  onChange={(event) => setRenamingTitle(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      renamingCommittedRef.current = true;
                      void commitRename(thread.id, renamingTitle, thread.title);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      renamingCommittedRef.current = true;
                      cancelRename();
                    }
                  }}
                  onBlur={() => {
                    if (!renamingCommittedRef.current) {
                      void commitRename(thread.id, renamingTitle, thread.title);
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {terminalStatus && (
                <span
                  role="img"
                  aria-label={terminalStatus.label}
                  title={terminalStatus.label}
                  className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                >
                  <TerminalIcon
                    className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`}
                  />
                </span>
              )}
              <span
                className={`text-[10px] ${
                  isHighlighted
                    ? "text-foreground/72 dark:text-foreground/82"
                    : "text-muted-foreground/40"
                }`}
              >
                {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
              </span>
            </div>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      );
    },
    [
      cancelRename,
      clearSelection,
      commitRename,
      handleMultiSelectContextMenu,
      handleThreadClick,
      handleThreadContextMenu,
      navigate,
      openPrLink,
      prByThreadId,
      renamingThreadId,
      renamingTitle,
      routeThreadId,
      selectedThreadIds,
      setSelectionAnchor,
      threadLastVisitedAtById,
      terminalStateByThreadId,
    ],
  );
  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex min-w-0 flex-1 items-center gap-1 ml-1 cursor-pointer">
              <T3Wordmark />
              <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
                Cork
              </span>
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                {APP_STAGE_LABEL}
              </span>
            </div>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return (
    <>
      {isElectron ? (
        <>
          <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
            {wordmark}
            {showDesktopUpdateButton && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={desktopUpdateTooltip}
                      aria-disabled={desktopUpdateButtonDisabled || undefined}
                      disabled={desktopUpdateButtonDisabled}
                      className={`inline-flex size-7 ml-auto mt-1.5 items-center justify-center rounded-md text-muted-foreground transition-colors ${desktopUpdateButtonInteractivityClasses} ${desktopUpdateButtonClasses}`}
                      onClick={handleDesktopUpdateButtonClick}
                    >
                      <RocketIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{desktopUpdateTooltip}</TooltipPopup>
              </Tooltip>
            )}
          </SidebarHeader>
        </>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      <SidebarContent className="gap-0">
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="px-2 py-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Projects
            </span>
            <div className="flex items-center gap-1">
              <ProjectSortMenu
                projectSortOrder={appSettings.sidebarProjectSortOrder}
                threadSortOrder={appSettings.sidebarThreadSortOrder}
                onProjectSortOrderChange={(sortOrder) => {
                  updateSettings({ sidebarProjectSortOrder: sortOrder });
                }}
                onThreadSortOrderChange={(sortOrder) => {
                  updateSettings({ sidebarThreadSortOrder: sortOrder });
                }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                      aria-pressed={shouldShowProjectPathEntry}
                      className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                      onClick={handleStartAddProject}
                    />
                  }
                >
                  <PlusIcon
                    className={`size-3.5 transition-transform duration-150 ${
                      shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                    }`}
                  />
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                </TooltipPopup>
              </Tooltip>
            </div>
          </div>

          {shouldShowProjectPathEntry && (
            <div className="mb-2 px-1">
              {isElectron && (
                <button
                  type="button"
                  className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void handlePickFolder()}
                  disabled={isPickingFolder || isAddingProject}
                >
                  <FolderIcon className="size-3.5" />
                  {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                </button>
              )}
              <div className="flex gap-1.5">
                <input
                  ref={addProjectInputRef}
                  className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                    addProjectError
                      ? "border-red-500/70 focus:border-red-500"
                      : "border-border focus:border-ring"
                  }`}
                  placeholder="/path/to/project"
                  value={newCwd}
                  onChange={(event) => {
                    setNewCwd(event.target.value);
                    setAddProjectError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleAddProject();
                    if (event.key === "Escape") {
                      setAddingProject(false);
                      setAddProjectError(null);
                    }
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                  onClick={handleAddProject}
                  disabled={!canAddProject}
                >
                  {isAddingProject ? "Adding..." : "Add"}
                </button>
              </div>
              {addProjectError && (
                <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                  {addProjectError}
                </p>
              )}
              <div className="mt-1.5 px-0.5">
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                  onClick={() => {
                    setAddingProject(false);
                    setAddProjectError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {isManualProjectSorting ? (
            <DndContext
              sensors={projectDnDSensors}
              collisionDetection={projectCollisionDetection}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragStart={handleProjectDragStart}
              onDragEnd={handleProjectDragEnd}
              onDragCancel={handleProjectDragCancel}
            >
              <SidebarMenu>
                <SortableContext
                  items={orderedProjects.map((project) => project.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {projectSidebarSections.map((section) => {
                    const {
                      hasHiddenThreadEntries,
                      isProjectExpanded,
                      isThreadListExpanded,
                      orderedProjectThreadIds,
                      project,
                      projectStatus,
                      visibleThreadEntries,
                    } = section;
                    return (
                      <SortableProjectItem key={project.id} projectId={project.id}>
                        {(dragHandleProps) => (
                          <Collapsible className="group/collapsible" open={isProjectExpanded}>
                            <div className="group/project-header relative">
                              <SidebarMenuButton
                                size="sm"
                                className="gap-2 px-2 py-1.5 text-left cursor-grab active:cursor-grabbing hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
                                {...dragHandleProps.attributes}
                                {...dragHandleProps.listeners}
                                onPointerDownCapture={handleProjectTitlePointerDownCapture}
                                onClick={(event) => handleProjectTitleClick(event, project.id)}
                                onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  void handleProjectContextMenu(project.id, {
                                    x: event.clientX,
                                    y: event.clientY,
                                  });
                                }}
                              >
                                {!isProjectExpanded && projectStatus ? (
                                  <span
                                    aria-hidden="true"
                                    title={projectStatus.label}
                                    className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
                                  >
                                    <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                                      <span
                                        className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                                          projectStatus.pulse ? "animate-pulse" : ""
                                        }`}
                                      />
                                    </span>
                                    <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
                                  </span>
                                ) : (
                                  <ChevronRightIcon
                                    className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                                      isProjectExpanded ? "rotate-90" : ""
                                    }`}
                                  />
                                )}
                                <ProjectFavicon cwd={project.cwd} />
                                <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                                  {project.name}
                                </span>
                              </SidebarMenuButton>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <SidebarMenuAction
                                      render={
                                        <button
                                          type="button"
                                          aria-label={`Create new thread in ${project.name}`}
                                          data-testid="new-thread-button"
                                        />
                                      }
                                      showOnHover
                                      className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        void handleNewThread(project.id, {
                                          envMode: resolveSidebarNewThreadEnvMode({
                                            defaultEnvMode: appSettings.defaultThreadEnvMode,
                                          }),
                                          codexFastMode: appSettings.defaultCodexFastMode,
                                          codexReasoningEffort:
                                            appSettings.defaultCodexReasoningEffort,
                                        });
                                      }}
                                    >
                                      <SquarePenIcon className="size-3.5" />
                                    </SidebarMenuAction>
                                  }
                                />
                                <TooltipPopup side="top">
                                  {newThreadShortcutLabel
                                    ? `New thread (${newThreadShortcutLabel})`
                                    : "New thread"}
                                </TooltipPopup>
                              </Tooltip>
                            </div>

                            <CollapsibleContent keepMounted>
                              <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0.5 px-1.5 py-0">
                                {visibleThreadEntries.map((entry) => {
                                  if (entry.kind === "thread") {
                                    return renderThreadRow(entry.thread, orderedProjectThreadIds, {
                                      topLevelDataThreadId: entry.thread.id,
                                    });
                                  }

                                  const isCollapsed = collapsedWorktreeGroupKeySet.has(
                                    entry.groupKey,
                                  );
                                  const isAnimatingGroup = animatingGroupKeys.has(entry.groupKey);
                                  const shouldAnimateGroupChildren =
                                    isAnimatingGroup && !isCollapsed && !prefersReducedMotion;

                                  return (
                                    <SidebarMenuSubItem
                                      key={entry.groupKey}
                                      className="w-full"
                                      data-thread-selection-safe
                                    >
                                      <Collapsible
                                        className="w-full"
                                        open={!isCollapsed}
                                        onOpenChange={(open) => {
                                          setWorktreeGroupCollapsed(entry.groupKey, !open);
                                        }}
                                      >
                                        <div
                                          ref={(element) => {
                                            registerWorktreeGroupElement(entry.groupKey, element);
                                          }}
                                          data-worktree-group-key={entry.groupKey}
                                          className={`overflow-hidden rounded-xl border border-border/60 bg-muted/20 ${
                                            isAnimatingGroup ? "sidebar-worktree-group-born" : ""
                                          }`}
                                        >
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-accent/60"
                                            data-thread-selection-safe
                                            onContextMenu={(event) => {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              void handleWorktreeGroupContextMenu(
                                                project.id,
                                                {
                                                  worktreePath: entry.worktreePath,
                                                  worktreeTitleStatus: entry.worktreeTitleStatus,
                                                  worktreeTitleUpdatedAt:
                                                    entry.worktreeTitleUpdatedAt,
                                                },
                                                {
                                                  x: event.clientX,
                                                  y: event.clientY,
                                                },
                                              );
                                            }}
                                            onClick={() => {
                                              setWorktreeGroupCollapsed(
                                                entry.groupKey,
                                                !isCollapsed,
                                              );
                                            }}
                                          >
                                            <ChevronRightIcon
                                              className={`size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                                                isCollapsed ? "" : "rotate-90"
                                              }`}
                                            />
                                            <Tooltip>
                                              <TooltipTrigger
                                                render={
                                                  entry.worktreeTitleStatus === "pending" ? (
                                                    <Skeleton className="h-3.5 w-28 rounded-full" />
                                                  ) : (
                                                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/85">
                                                      {entry.label}
                                                    </span>
                                                  )
                                                }
                                              />
                                              <TooltipPopup side="top">
                                                {entry.worktreePath}
                                              </TooltipPopup>
                                            </Tooltip>
                                          </button>

                                          <CollapsibleContent keepMounted>
                                            <SidebarMenuSub className="mx-0 translate-x-0 border-t border-border/50 px-1.5 py-1">
                                              {entry.threads.map((thread, index) =>
                                                renderThreadRow(
                                                  thread,
                                                  orderedProjectThreadIds,
                                                  shouldAnimateGroupChildren
                                                    ? {
                                                        childAnimationIndex: index,
                                                      }
                                                    : undefined,
                                                ),
                                              )}
                                            </SidebarMenuSub>
                                          </CollapsibleContent>
                                        </div>
                                      </Collapsible>
                                    </SidebarMenuSubItem>
                                  );
                                })}

                                {hasHiddenThreadEntries && !isThreadListExpanded && (
                                  <SidebarMenuSubItem className="w-full">
                                    <SidebarMenuSubButton
                                      render={<button type="button" />}
                                      data-thread-selection-safe
                                      size="sm"
                                      className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                      onClick={() => {
                                        expandThreadListForProject(project.id);
                                      }}
                                    >
                                      <span>Show more</span>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                )}
                                {hasHiddenThreadEntries && isThreadListExpanded && (
                                  <SidebarMenuSubItem className="w-full">
                                    <SidebarMenuSubButton
                                      render={<button type="button" />}
                                      data-thread-selection-safe
                                      size="sm"
                                      className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                      onClick={() => {
                                        collapseThreadListForProject(project.id);
                                      }}
                                    >
                                      <span>Show less</span>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                )}
                              </SidebarMenuSub>
                            </CollapsibleContent>
                          </Collapsible>
                        )}
                      </SortableProjectItem>
                    );
                  })}
                </SortableContext>
              </SidebarMenu>
            </DndContext>
          ) : (
            <SidebarMenu ref={attachProjectListAutoAnimateRef}>
              {sortedProjectTree.map((projectNode) => (
                <SidebarMenuItem key={projectNode.project.id} className="rounded-md">
                  {renderProjectItem(projectNode, null)}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}

          {projects.length === 0 && !shouldShowProjectPathEntry && (
            <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
              No projects yet
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            {isOnSettings ? (
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => window.history.back()}
              >
                <ArrowLeftIcon className="size-3.5" />
                <span className="text-xs">Back</span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => void navigate({ to: "/settings" })}
              >
                <SettingsIcon className="size-3.5" />
                <span className="text-xs">Settings</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
