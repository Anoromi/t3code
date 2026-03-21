import { type ProjectId, type ResolvedKeybindingsConfig, type ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { NavigationCommandMenu } from "../components/NavigationCommandMenu";
import ThreadSidebar from "../components/Sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { useComposerDraftStore } from "../composerDraftStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useStore } from "../store";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";
import { SidebarRail } from "~/components/ui/sidebar";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
const GLOBAL_KEYDOWN_EVENT_OPTIONS = { capture: true } as const;

function ChatRouteGlobalShortcuts(props: {
  navigationCommandMenuOpen: boolean;
  onOpenNavigationCommandMenu: () => void;
}) {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread, routeThreadId } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );
  const appSettings = useSettings();

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

      const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId;
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

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
          worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
          envMode:
            activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
          codexFastMode: appSettings.defaultCodexFastMode,
        });
        return;
      }
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
    defaultProjectId,
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
  const appSettings = useSettings();
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
        codexFastMode: appSettings.defaultCodexFastMode,
      });
    },
    [appSettings.defaultCodexFastMode, appSettings.defaultThreadEnvMode, handleNewThread],
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
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      <Outlet />
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
