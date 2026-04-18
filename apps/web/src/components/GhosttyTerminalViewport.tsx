import { FitAddon, Terminal } from "ghostty-web";
import { type TerminalEvent, type TerminalSessionSnapshot } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readEnvironmentApi } from "~/environmentApi";
import { readLocalApi } from "~/localApi";
import { openInPreferredEditor } from "../editorPreferences";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from "../terminal-links";
import { selectTerminalEventEntries, useTerminalStateStore } from "../terminalStateStore";
import { ensureGhosttyWebReady } from "../lib/ghosttyWeb";
import {
  type TerminalViewportProps,
  describeTerminalExit,
  getTerminalSelectionRect,
  resolveTerminalSelectionActionPosition,
  selectPendingTerminalEventEntries,
  selectTerminalEventEntriesAfterSnapshot,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
  terminalThemeFromApp,
  writeSystemMessage,
  writeTerminalSnapshot,
} from "./terminalViewportShared";

export default function GhosttyTerminalViewport({
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  command,
  onSessionExited,
  onAddTerminalContext,
  onSessionSnapshot,
  onSessionEvent,
  onOpenError,
  eventSubscription,
  eventEntriesSelector,
  eventStoreSubscribe,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  restartToken = 0,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastKnownViewportSizeRef = useRef<{ width: number; height: number } | null>(null);
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const lastAppliedTerminalEventIdRef = useRef(0);
  const terminalHydratedRef = useRef(false);
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const handleSessionSnapshot = useEffectEvent((snapshot: TerminalSessionSnapshot) => {
    onSessionSnapshot?.(snapshot);
  });
  const handleSessionEvent = useEffectEvent((event: TerminalEvent) => {
    onSessionEvent?.(event);
  });
  const handleOpenError = useEffectEvent((message: string) => {
    onOpenError?.(message);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;
    let cleanupSelectionTimer = false;
    let inputDisposable: { dispose: () => void } | null = null;
    let selectionDisposable: { dispose: () => void } | null = null;
    let unsubscribeTerminalEvents: () => void = () => {};
    let themeObserver: MutationObserver | null = null;
    let fitTimer = 0;
    const directEventSubscription = eventSubscription;
    const useDirectEventSubscription = directEventSubscription !== undefined;
    const readEventEntries = () =>
      eventEntriesSelector?.() ??
      selectTerminalEventEntries(
        useTerminalStateStore.getState().terminalEventEntriesByKey,
        threadRef,
        terminalId,
      );
    const subscribeToEventEntries = (
      listener: (
        nextEntries: ReturnType<typeof readEventEntries>,
        previousEntries: ReturnType<typeof readEventEntries>,
      ) => void,
    ) =>
      eventStoreSubscribe?.(listener) ??
      useTerminalStateStore.subscribe((state, previousState) => {
        listener(
          selectTerminalEventEntries(state.terminalEventEntriesByKey, threadRef, terminalId),
          selectTerminalEventEntries(
            previousState.terminalEventEntriesByKey,
            threadRef,
            terminalId,
          ),
        );
      });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };

    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }

      const localApi = readLocalApi();
      if (!localApi) {
        return;
      }

      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await localApi.contextMenu.show(
          [{ id: "add-to-chat", label: "Add to chat" }],
          nextAction.position,
        );
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        handleAddTerminalContext(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } finally {
        selectionActionOpenRef.current = false;
      }
    };

    const applyTerminalEvent = (event: TerminalEvent) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        return;
      }

      if (event.type === "activity") {
        return;
      }

      if (event.type === "output") {
        activeTerminal.write(event.data);
        clearSelectionAction();
        handleSessionEvent(event);
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        clearSelectionAction();
        writeTerminalSnapshot(activeTerminal, event.snapshot);
        handleSessionSnapshot(event.snapshot);
        handleSessionEvent(event);
        return;
      }

      if (event.type === "cleared") {
        clearSelectionAction();
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        handleSessionEvent(event);
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        handleSessionEvent(event);
        return;
      }

      writeSystemMessage(activeTerminal, describeTerminalExit(event));
      if (hasHandledExitRef.current) {
        handleSessionEvent(event);
        return;
      }
      hasHandledExitRef.current = true;
      handleSessionEvent(event);
      window.setTimeout(() => {
        if (!hasHandledExitRef.current) {
          return;
        }
        handleSessionExited();
      }, 0);
    };

    const applyPendingTerminalEvents = (
      terminalEventEntries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
    ) => {
      const pendingEntries = selectPendingTerminalEventEntries(
        terminalEventEntries,
        lastAppliedTerminalEventIdRef.current,
      );
      if (pendingEntries.length === 0) {
        return;
      }
      for (const entry of pendingEntries) {
        applyTerminalEvent(entry.event);
      }
      lastAppliedTerminalEventIdRef.current =
        pendingEntries.at(-1)?.id ?? lastAppliedTerminalEventIdRef.current;
    };

    const isScrolledToBottom = (terminal: Terminal): boolean => terminal.getViewportY() <= 0.5;

    const fitAndSyncSize = async (options?: { keepBottom?: boolean }) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!api || !terminal || !fitAddon) {
        return;
      }

      const wasAtBottom = options?.keepBottom ? isScrolledToBottom(terminal) : false;
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      await api.terminal.resize({
        threadId,
        terminalId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    const initialize = async () => {
      try {
        await ensureGhosttyWebReady();
        if (disposed) {
          return;
        }

        const fitAddon = new FitAddon();
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: 12,
          scrollback: 5_000,
          fontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
          theme: terminalThemeFromApp(),
        });

        terminal.loadAddon(fitAddon);
        terminal.open(mount);
        fitAddon.fit();

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        const api = readEnvironmentApi(threadRef.environmentId);
        const localApi = readLocalApi();
        if (!api || !localApi) {
          const message = "The native terminal API is unavailable.";
          writeSystemMessage(terminal, message);
          handleOpenError(message);
          return;
        }

        const sendTerminalInput = async (data: string, fallbackError: string) => {
          const activeTerminal = terminalRef.current;
          if (!activeTerminal) return;
          try {
            await api.terminal.write({ threadId, terminalId, data });
          } catch (error) {
            writeSystemMessage(
              activeTerminal,
              error instanceof Error ? error.message : fallbackError,
            );
          }
        };

        terminal.attachCustomKeyEventHandler((event) => {
          const navigationData = terminalNavigationShortcutData(event);
          if (navigationData !== null) {
            event.preventDefault();
            event.stopPropagation();
            void sendTerminalInput(navigationData, "Failed to move cursor");
            return true;
          }

          if (!isTerminalClearShortcut(event)) {
            return false;
          }

          event.preventDefault();
          event.stopPropagation();
          void sendTerminalInput("\u000c", "Failed to clear terminal");
          return true;
        });

        terminal.registerLinkProvider({
          provideLinks: (bufferLineNumber, callback) => {
            const activeTerminal = terminalRef.current;
            if (!activeTerminal) {
              callback(undefined);
              return;
            }

            const line = activeTerminal.buffer.active.getLine(bufferLineNumber - 1);
            if (!line) {
              callback(undefined);
              return;
            }

            const lineText = line.translateToString(true);
            const matches = extractTerminalLinks(lineText);
            if (matches.length === 0) {
              callback(undefined);
              return;
            }

            callback(
              matches.map((match) => ({
                text: match.text,
                range: {
                  start: { x: match.start + 1, y: bufferLineNumber },
                  end: { x: match.end, y: bufferLineNumber },
                },
                activate: (event: MouseEvent) => {
                  if (!isTerminalLinkActivation(event)) return;

                  const latestTerminal = terminalRef.current;
                  if (!latestTerminal) return;

                  if (match.kind === "url") {
                    void localApi.shell.openExternal(match.text).catch((error) => {
                      writeSystemMessage(
                        latestTerminal,
                        error instanceof Error ? error.message : "Unable to open link",
                      );
                    });
                    return;
                  }

                  const target = resolvePathLinkTarget(match.text, cwd);
                  void openInPreferredEditor(localApi, target).catch((error) => {
                    writeSystemMessage(
                      latestTerminal,
                      error instanceof Error ? error.message : "Unable to open path",
                    );
                  });
                },
              })),
            );
          },
        });

        inputDisposable = terminal.onData((data) => {
          void api.terminal
            .write({ threadId, terminalId, data })
            .catch((err) =>
              writeSystemMessage(
                terminal,
                err instanceof Error ? err.message : "Terminal write failed",
              ),
            );
        });

        selectionDisposable = terminal.onSelectionChange(() => {
          if (terminalRef.current?.hasSelection()) {
            return;
          }
          clearSelectionAction();
        });

        window.addEventListener("mouseup", handleMouseUp);
        mount.addEventListener("pointerdown", handlePointerDown);
        cleanupSelectionTimer = true;

        themeObserver = new MutationObserver(() => {
          const activeTerminal = terminalRef.current;
          if (!activeTerminal) return;
          activeTerminal.options.theme = terminalThemeFromApp();
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class", "style"],
        });

        if (useDirectEventSubscription) {
          unsubscribeTerminalEvents = directEventSubscription((event) => {
            if (!terminalHydratedRef.current) {
              return;
            }
            applyTerminalEvent(event);
          });
        } else {
          unsubscribeTerminalEvents = subscribeToEventEntries((nextEntries, previousEntries) => {
            if (!terminalHydratedRef.current) {
              return;
            }

            const previousLastEntryId = previousEntries.at(-1)?.id ?? 0;
            const nextLastEntryId = nextEntries.at(-1)?.id ?? 0;
            if (nextLastEntryId === previousLastEntryId) {
              return;
            }

            applyPendingTerminalEvents(nextEntries);
          });
        }

        fitTimer = window.setTimeout(() => {
          if (!terminalHydratedRef.current) {
            return;
          }
          void fitAndSyncSize({ keepBottom: true }).catch(() => undefined);
        }, 30);

        terminalHydratedRef.current = false;
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          cols: terminal.cols,
          rows: terminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
          ...(command ? { command } : {}),
        });
        if (disposed) {
          return;
        }

        writeTerminalSnapshot(terminal, snapshot);
        handleSessionSnapshot(snapshot);
        if (!useDirectEventSubscription) {
          const bufferedEntries = readEventEntries();
          const replayEntries = selectTerminalEventEntriesAfterSnapshot(
            bufferedEntries,
            snapshot.updatedAt,
          );
          for (const entry of replayEntries) {
            applyTerminalEvent(entry.event);
          }
          lastAppliedTerminalEventIdRef.current = bufferedEntries.at(-1)?.id ?? 0;
        }
        terminalHydratedRef.current = true;

        if (autoFocus) {
          window.requestAnimationFrame(() => {
            terminal.focus();
          });
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        const message = error instanceof Error ? error.message : "Failed to open terminal";
        const activeTerminal = terminalRef.current;
        if (activeTerminal) {
          writeSystemMessage(activeTerminal, message);
        }
        handleOpenError(message);
      }
    };

    void initialize();

    return () => {
      disposed = true;
      terminalHydratedRef.current = false;
      lastAppliedTerminalEventIdRef.current = 0;
      unsubscribeTerminalEvents();
      if (fitTimer !== 0) {
        window.clearTimeout(fitTimer);
      }
      inputDisposable?.dispose();
      selectionDisposable?.dispose();
      if (cleanupSelectionTimer) {
        window.removeEventListener("mouseup", handleMouseUp);
        mount.removeEventListener("pointerdown", handlePointerDown);
      }
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      themeObserver?.disconnect();
      const activeTerminal = terminalRef.current;
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastKnownViewportSizeRef.current = null;
      activeTerminal?.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    command,
    cwd,
    eventSubscription,
    eventEntriesSelector,
    eventStoreSubscribe,
    runtimeEnv,
    terminalId,
    threadId,
    worktreePath,
  ]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    const api = readEnvironmentApi(threadRef.environmentId);
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.getViewportY() <= 0.5;
    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      if (!terminalHydratedRef.current) {
        return;
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => undefined);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, resizeEpoch, terminalId, threadId, threadRef.environmentId]);

  useEffect(() => {
    const container = containerRef.current;
    const api = readEnvironmentApi(threadRef.environmentId);
    if (!container || !api) return;

    let frame = 0;
    const fitToContainer = () => {
      frame = 0;
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!terminal || !fitAddon) {
        return;
      }

      const nextSize = {
        width: Math.round(container.clientWidth),
        height: Math.round(container.clientHeight),
      };
      const previousSize = lastKnownViewportSizeRef.current;
      if (
        previousSize &&
        previousSize.width === nextSize.width &&
        previousSize.height === nextSize.height
      ) {
        return;
      }
      lastKnownViewportSizeRef.current = nextSize;

      const wasAtBottom = terminal.getViewportY() <= 0.5;
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      if (!terminalHydratedRef.current) {
        return;
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => undefined);
    };

    const scheduleFit = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(fitToContainer);
    };

    scheduleFit();
    const observer = new ResizeObserver(() => {
      scheduleFit();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [terminalId, threadId, threadRef.environmentId]);

  useEffect(() => {
    if (restartToken === 0) {
      return;
    }

    const api = readEnvironmentApi(threadRef.environmentId);
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        terminalHydratedRef.current = false;
        fitAddon.fit();
        const snapshot = await api.terminal.restart({
          threadId,
          terminalId,
          cwd,
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          cols: terminal.cols,
          rows: terminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
          ...(command ? { command } : {}),
        });
        if (cancelled) {
          return;
        }
        hasHandledExitRef.current = false;
        writeTerminalSnapshot(terminal, snapshot);
        handleSessionSnapshot(snapshot);
        terminalHydratedRef.current = true;
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : "Failed to restart terminal";
        writeSystemMessage(terminal, message);
        handleOpenError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [command, cwd, restartToken, runtimeEnv, terminalId, threadId, worktreePath]);

  return (
    <div
      ref={containerRef}
      data-terminal-focus-root="true"
      className="relative h-full w-full overflow-hidden rounded-[4px] caret-transparent"
    />
  );
}
