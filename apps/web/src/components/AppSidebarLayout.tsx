import { useAtomValue } from "@effect/atom-react";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { isCommandPaletteOpen } from "../commandPaletteContext";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectProjectGroupingSettings } from "../logicalProject";
import { isMacPlatform } from "../lib/utils";
import { isNavigationCommandMenuOpen } from "../navigationCommandMenu";
import { useProjects, useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { NavigationCommandMenu } from "./NavigationCommandMenu";
import { resolveDraftProjectKeys } from "./NavigationCommandMenu.logic";
import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isNavigationCommandMenuOpen()) return;
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, toggleSidebar]);

  return (
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger className="pointer-events-auto" aria-label="Toggle main sidebar" />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function NavigationCommandMenuControl() {
  const [open, setOpen] = useState(false);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectDraftThreadKeyByLogicalProjectKey = useComposerDraftStore(
    (state) => state.logicalProjectDraftThreadKeyByLogicalProjectKey,
  );
  const draftProjectKeys = useMemo(
    () =>
      resolveDraftProjectKeys({
        projects,
        draftLogicalProjectKeys: new Set(
          Object.keys(logicalProjectDraftThreadKeyByLogicalProjectKey),
        ),
        projectGroupingSettings,
      }),
    [logicalProjectDraftThreadKeyByLogicalProjectKey, projectGroupingSettings, projects],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      if (
        resolveShortcutCommand(event, keybindings, {
          context: { terminalFocus: isTerminalFocused() },
        }) !== "navigation.commandMenu"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  const selectThread = useCallback(
    async (ref: ScopedThreadRef) => {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
    },
    [navigate],
  );
  const selectProject = useCallback(
    async (ref: ScopedProjectRef) => {
      await handleNewThread(ref);
    },
    [handleNewThread],
  );

  return (
    <NavigationCommandMenu
      open={open}
      onOpenChange={setOpen}
      projects={projects}
      threads={threads}
      draftProjectKeys={draftProjectKeys}
      onSelectThread={selectThread}
      onSelectProject={selectProject}
    />
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });
  const macosWindowControlsStyle =
    isMacosDesktop && !isWindowFullscreen
      ? ({ "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET } as CSSProperties)
      : undefined;

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={macosWindowControlsStyle}>
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
      <SidebarControl />
      <NavigationCommandMenuControl />
    </SidebarProvider>
  );
}
