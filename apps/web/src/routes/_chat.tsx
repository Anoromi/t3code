import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { NavigationCommandMenu } from "../components/NavigationCommandMenu";
import ThreadSidebar from "../components/Sidebar";
import { resolveSidebarNewThreadEnvMode } from "../components/Sidebar.logic";
import { Sidebar, SidebarProvider, SidebarRail } from "../components/ui/sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isTerminalFocused, shouldBypassGlobalTerminalShortcuts } from "../lib/terminalFocus";
import { couldMatchShortcutCommand, resolveShortcutCommand } from "../keybindings";
import { useServerKeybindings } from "../rpc/serverState";
import {
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useUiStateStore } from "../uiStateStore";
import { resolveChatGlobalShortcutAction } from "../lib/chatGlobalShortcuts";
import { openWorktreeTerminalForProject } from "../lib/worktreeTerminal";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
const GLOBAL_KEYDOWN_EVENT_OPTIONS = { capture: true } as const;

function ChatRouteGlobalShortcuts(props: {
  navigationCommandMenuOpen: boolean;
  onOpenNavigationCommandMenu: () => void;
}) {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
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
      if (event.defaultPrevented) return;
      if (shouldBypassGlobalTerminalShortcuts()) return;
      if (
        event.key !== "Escape" &&
        !couldMatchShortcutCommand(
          event,
          keybindings,
          (command) =>
            command === "navigation.commandMenu" ||
            command === "chat.newLocal" ||
            command === "chat.new" ||
            command === "terminal.worktree.open",
        )
      ) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (useCommandPaletteStore.getState().open) {
        return;
      }

      if (
        event.key === "Escape" &&
        selectedThreadKeysSize > 0 &&
        !props.navigationCommandMenuOpen
      ) {
        event.preventDefault();
        clearSelection();
        return;
      }

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
        props.onOpenNavigationCommandMenu();
        return;
      }

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
          defaultCodexFastMode: appSettings.defaultCodexFastMode,
          defaultCodexReasoningEffort: appSettings.defaultCodexReasoningEffort,
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
          defaultCodexFastMode: appSettings.defaultCodexFastMode,
          defaultCodexReasoningEffort: appSettings.defaultCodexReasoningEffort,
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
    appSettings.defaultCodexFastMode,
    appSettings.defaultCodexReasoningEffort,
    appSettings.defaultThreadEnvMode,
    clearSelection,
    defaultProjectRef,
    handleNewThread,
    keybindings,
    props.navigationCommandMenuOpen,
    props.onOpenNavigationCommandMenu,
    selectedThreadKeysSize,
    terminalOpen,
  ]);

  return null;
}

function ChatRouteLayout() {
  const [navigationCommandMenuOpen, setNavigationCommandMenuOpen] = useState(false);
  const navigate = useNavigate();
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
        codexFastMode: appSettings.defaultCodexFastMode,
        codexReasoningEffort: appSettings.defaultCodexReasoningEffort,
      });
    },
    [
      appSettings.defaultCodexFastMode,
      appSettings.defaultCodexReasoningEffort,
      appSettings.defaultThreadEnvMode,
      handleNewThread,
      projects,
    ],
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
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
