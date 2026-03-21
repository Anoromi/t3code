import { type ProjectId, type ResolvedKeybindingsConfig, type ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { NavigationCommandMenu } from "../components/NavigationCommandMenu";
import ThreadSidebar from "../components/Sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { isTerminalFocused } from "../lib/terminalFocus";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { resolveShortcutCommand } from "../keybindings";
import { useComposerDraftStore } from "../composerDraftStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useStore } from "../store";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useAppSettings } from "~/appSettings";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const GLOBAL_KEYDOWN_EVENT_OPTIONS = { capture: true } as const;

function ChatRouteGlobalShortcuts(props: {
  navigationCommandMenuOpen: boolean;
  onOpenNavigationCommandMenu: () => void;
}) {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const { activeDraftThread, activeThread, handleNewThread, projects, routeThreadId } =
    useHandleNewThread();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );
  const { settings: appSettings } = useAppSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape" && selectedThreadIdsSize > 0 && !props.navigationCommandMenuOpen) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (command === "navigation.commandMenu") {
        event.preventDefault();
        event.stopPropagation();
        props.onOpenNavigationCommandMenu();
        return;
      }

      const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
      if (!projectId) return;

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          codexFastMode: appSettings.defaultCodexFastMode,
        });
        return;
      }

      if (command !== "chat.new") return;
      event.preventDefault();
      event.stopPropagation();
      void handleNewThread(projectId, {
        branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
        envMode: activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
        codexFastMode: appSettings.defaultCodexFastMode,
      });
    };

    // Capture phase keeps global shortcuts available while the embedded terminal has focus.
    window.addEventListener("keydown", onWindowKeyDown, GLOBAL_KEYDOWN_EVENT_OPTIONS);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, GLOBAL_KEYDOWN_EVENT_OPTIONS);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    projects,
    selectedThreadIdsSize,
    terminalOpen,
    appSettings.defaultCodexFastMode,
    appSettings.defaultThreadEnvMode,
    props,
  ]);

  return null;
}

function ChatRouteLayout() {
  const [navigationCommandMenuOpen, setNavigationCommandMenuOpen] = useState(false);
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const draftProjectThreadIds = useComposerDraftStore(
    (store) => store.projectDraftThreadIdByProjectId,
  );
  const { handleNewThread } = useHandleNewThread();
  const { settings: appSettings } = useAppSettings();
  const draftProjectIds = useMemo(
    () => new Set(Object.keys(draftProjectThreadIds) as ProjectId[]),
    [draftProjectThreadIds],
  );

  const handleOpenNavigationCommandMenu = useCallback(() => {
    setNavigationCommandMenuOpen(true);
  }, []);

  const handleSelectThread = useCallback(
    async (threadId: ThreadId) => {
      const thread = threads.find((entry) => entry.id === threadId);
      setNavigationCommandMenuOpen(false);
      if (thread) {
        setProjectExpanded(thread.projectId, true);
      }
      await navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [navigate, setProjectExpanded, threads],
  );

  const handleSelectProject = useCallback(
    async (projectId: ProjectId) => {
      setNavigationCommandMenuOpen(false);
      await handleNewThread(projectId, {
        envMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: appSettings.defaultThreadEnvMode,
        }),
      });
    },
    [appSettings.defaultThreadEnvMode, handleNewThread],
  );

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <SidebarProvider defaultOpen>
      <ChatRouteGlobalShortcuts
        navigationCommandMenuOpen={navigationCommandMenuOpen}
        onOpenNavigationCommandMenu={handleOpenNavigationCommandMenu}
      />
      <NavigationCommandMenu
        open={navigationCommandMenuOpen}
        onOpenChange={setNavigationCommandMenuOpen}
        projects={projects}
        threads={threads}
        draftProjectIds={draftProjectIds}
        onSelectThread={handleSelectThread}
        onSelectProject={handleSelectProject}
      />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
      >
        <ThreadSidebar />
      </Sidebar>
      <Outlet />
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
