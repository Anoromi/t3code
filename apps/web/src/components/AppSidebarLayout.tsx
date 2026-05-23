import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { resolveChatGlobalShortcutAction } from "../lib/chatGlobalShortcuts";
import { isTerminalFocused, shouldBypassGlobalTerminalShortcuts } from "../lib/terminalFocus";
import { openWorktreeTerminalForProject } from "../lib/worktreeTerminal";
import { resolveShortcutCommand } from "../keybindings";
import { useServerKeybindings } from "../rpc/serverState";
import {
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams } from "../threadRoutes";
import ThreadSidebar from "./Sidebar";
import { resolveSidebarNewThreadEnvMode } from "./Sidebar.logic";
import { NavigationCommandMenu } from "./NavigationCommandMenu";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";
import { useUiStateStore } from "../uiStateStore";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
const GLOBAL_KEYDOWN_EVENT_OPTIONS = { capture: true } as const;

function AppGlobalShortcuts({
  navigationCommandMenuOpen,
  onOpenNavigationCommandMenu,
}: {
  navigationCommandMenuOpen: boolean;
  onOpenNavigationCommandMenu: () => void;
}) {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const appSettings = useSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shouldBypassGlobalTerminalShortcuts()) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      const action = resolveChatGlobalShortcutAction({
        command:
          command === "navigation.commandMenu" ||
          command === "chat.newLocal" ||
          command === "chat.new" ||
          command === "terminal.worktree.open"
            ? command
            : null,
        activeThread: activeThread ?? null,
        activeDraftThread,
        defaultProjectId: defaultProjectRef?.projectId ?? null,
      });

      if (action?.type === "navigation.commandMenu") {
        event.preventDefault();
        event.stopPropagation();
        onOpenNavigationCommandMenu();
        return;
      }

      if (navigationCommandMenuOpen) return;

      if (action?.type === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewLocalThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
        return;
      }

      if (action?.type === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
        return;
      }

      if (action?.type === "terminal.worktree.open") {
        event.preventDefault();
        event.stopPropagation();
        void openWorktreeTerminalForProject({
          projectId: action.projectId,
          worktreePath: action.worktreePath,
        });
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, GLOBAL_KEYDOWN_EVENT_OPTIONS);
    return () =>
      window.removeEventListener("keydown", onWindowKeyDown, GLOBAL_KEYDOWN_EVENT_OPTIONS);
  }, [
    activeDraftThread,
    activeThread,
    appSettings.defaultThreadEnvMode,
    defaultProjectRef,
    handleNewThread,
    keybindings,
    navigationCommandMenuOpen,
    onOpenNavigationCommandMenu,
    terminalOpen,
  ]);

  return null;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [navigationCommandMenuOpen, setNavigationCommandMenuOpen] = useState(false);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadsAcrossEnvironments));
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const { handleNewThread } = useHandleNewThread();
  const appSettings = useSettings();
  const draftProjectIds = useMemo(
    () => new Set(Object.values(draftThreadsByThreadKey).map((draft) => draft.projectId)),
    [draftThreadsByThreadKey],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowKeyUp = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowBlur = () => {
      clearShortcutModifierState();
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    window.addEventListener("keyup", onWindowKeyUp, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      window.removeEventListener("keyup", onWindowKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  const handleOpenNavigationCommandMenu = useCallback(() => {
    setNavigationCommandMenuOpen(true);
  }, []);

  const handleSelectThread = useCallback(
    async (threadId: ThreadId) => {
      const thread = threads.find((entry) => entry.id === threadId);
      setNavigationCommandMenuOpen(false);
      if (!thread) return;

      setProjectExpanded(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        true,
      );
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate, setProjectExpanded, threads],
  );

  const handleSelectProject = useCallback(
    async (projectId: ProjectId) => {
      const project = projects.find((entry) => entry.id === projectId);
      setNavigationCommandMenuOpen(false);
      if (!project) return;

      await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
        envMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: appSettings.defaultThreadEnvMode,
        }),
      });
    },
    [appSettings.defaultThreadEnvMode, handleNewThread, projects],
  );

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <AppGlobalShortcuts
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
      {children}
    </SidebarProvider>
  );
}
