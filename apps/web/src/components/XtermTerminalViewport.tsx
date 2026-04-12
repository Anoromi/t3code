import { FitAddon } from "@xterm/addon-fit";
import { type TerminalEvent, type TerminalSessionSnapshot } from "@t3tools/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useEffectEvent, useRef } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "~/nativeApi";
import { openInPreferredEditor } from "../editorPreferences";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from "../terminal-links";
import { selectTerminalEventEntries, useTerminalStateStore } from "../terminalStateStore";
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
import {
  clearXtermOutputBatchQueue,
  createXtermOutputBatchQueue,
  enqueueXtermOutputBatchChunk,
  hasQueuedXtermOutput,
  takeNextXtermOutputBatch,
  XTERM_OUTPUT_FLUSH_TIMEOUT_MS,
} from "./xtermOutputBatching";

export default function XtermTerminalViewport({
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
  const pendingOutputQueueRef = useRef(createXtermOutputBatchQueue());
  const outputWriteInFlightRef = useRef(false);
  const deferredTerminalActionsRef = useRef<Array<() => void>>([]);
  const outputFlushFrameRef = useRef<number | null>(null);
  const outputFlushTimeoutRef = useRef<number | null>(null);
  const clearScheduledOutputFlush = () => {
    if (outputFlushFrameRef.current !== null) {
      window.cancelAnimationFrame(outputFlushFrameRef.current);
      outputFlushFrameRef.current = null;
    }
    if (outputFlushTimeoutRef.current !== null) {
      window.clearTimeout(outputFlushTimeoutRef.current);
      outputFlushTimeoutRef.current = null;
    }
  };
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
    const pendingOutputQueue = pendingOutputQueueRef.current;
    const directEventSubscription = eventSubscription;
    const useDirectEventSubscription = directEventSubscription !== undefined;
    const readEventEntries = () =>
      eventEntriesSelector?.() ??
      selectTerminalEventEntries(
        useTerminalStateStore.getState().terminalEventEntriesByKey,
        threadId,
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
          selectTerminalEventEntries(state.terminalEventEntriesByKey, threadId, terminalId),
          selectTerminalEventEntries(previousState.terminalEventEntriesByKey, threadId, terminalId),
        );
      });

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp() as ITheme,
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    let webglAddonCleanup: (() => void) | null = null;
    void import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        if (disposed) {
          return;
        }
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          return;
        }

        try {
          const webglAddon = new WebglAddon();
          activeTerminal.loadAddon(webglAddon);
          const contextLossDisposable = webglAddon.onContextLoss(() => {
            contextLossDisposable.dispose();
            webglAddon.dispose();
            if (webglAddonCleanup) {
              webglAddonCleanup = null;
            }
          });
          webglAddonCleanup = () => {
            contextLossDisposable.dispose();
            webglAddon.dispose();
          };
        } catch {
          webglAddonCleanup = null;
        }
      })
      .catch(() => {
        webglAddonCleanup = null;
      });

    const api = readNativeApi();
    if (!api) {
      const message = "The native terminal API is unavailable.";
      writeSystemMessage(terminal, message);
      handleOpenError(message);
      return () => {
        terminalRef.current = null;
        fitAddonRef.current = null;
        terminal.dispose();
      };
    }

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };
    const hasDeferredTerminalActions = () => deferredTerminalActionsRef.current.length > 0;
    const drainDeferredTerminalActions = () => {
      if (outputWriteInFlightRef.current || hasQueuedXtermOutput(pendingOutputQueue)) {
        return;
      }

      while (deferredTerminalActionsRef.current.length > 0) {
        const nextAction = deferredTerminalActionsRef.current.shift();
        nextAction?.();
        if (outputWriteInFlightRef.current || hasQueuedXtermOutput(pendingOutputQueue)) {
          return;
        }
      }
    };
    const flushPendingOutputToTerminal = () => {
      clearScheduledOutputFlush();
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        return;
      }
      if (outputWriteInFlightRef.current) {
        return;
      }

      const nextBatch = takeNextXtermOutputBatch(pendingOutputQueue);
      if (nextBatch === null) {
        drainDeferredTerminalActions();
        return;
      }

      outputWriteInFlightRef.current = true;
      activeTerminal.write(nextBatch, () => {
        outputWriteInFlightRef.current = false;
        if (disposed) {
          return;
        }
        if (hasQueuedXtermOutput(pendingOutputQueue)) {
          flushPendingOutputToTerminal();
          return;
        }
        drainDeferredTerminalActions();
      });
    };
    const scheduleOutputFlush = () => {
      if (outputWriteInFlightRef.current) {
        return;
      }
      if (outputFlushFrameRef.current !== null || outputFlushTimeoutRef.current !== null) {
        return;
      }

      outputFlushFrameRef.current = window.requestAnimationFrame(() => {
        outputFlushFrameRef.current = null;
        flushPendingOutputToTerminal();
      });
      outputFlushTimeoutRef.current = window.setTimeout(() => {
        outputFlushTimeoutRef.current = null;
        flushPendingOutputToTerminal();
      }, XTERM_OUTPUT_FLUSH_TIMEOUT_MS);
    };
    const enqueueDeferredTerminalAction = (action: () => void) => {
      deferredTerminalActionsRef.current.push(action);
      if (outputWriteInFlightRef.current || hasQueuedXtermOutput(pendingOutputQueue)) {
        flushPendingOutputToTerminal();
        return;
      }
      drainDeferredTerminalActions();
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
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await api.contextMenu.show(
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

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
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
                void api.shell.openExternal(match.text).catch((error) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void openInPreferredEditor(api, target).catch((error) => {
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

    const inputDisposable = terminal.onData((data) => {
      void api.terminal
        .write({ threadId, terminalId, data })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
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
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp() as ITheme;
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const applyTerminalEvent = (event: TerminalEvent) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        return;
      }

      if (event.type === "activity") {
        return;
      }

      if (event.type === "output") {
        if (hasDeferredTerminalActions()) {
          enqueueDeferredTerminalAction(() => {
            enqueueXtermOutputBatchChunk(pendingOutputQueue, event.data);
            clearSelectionAction();
            handleSessionEvent(event);
            flushPendingOutputToTerminal();
          });
          return;
        }

        enqueueXtermOutputBatchChunk(pendingOutputQueue, event.data);
        clearSelectionAction();
        scheduleOutputFlush();
        handleSessionEvent(event);
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        const applyStartedEvent = () => {
          const latestTerminal = terminalRef.current;
          if (!latestTerminal) {
            return;
          }
          hasHandledExitRef.current = false;
          clearSelectionAction();
          writeTerminalSnapshot(latestTerminal, event.snapshot);
          handleSessionSnapshot(event.snapshot);
          handleSessionEvent(event);
        };
        if (outputWriteInFlightRef.current || hasQueuedXtermOutput(pendingOutputQueue)) {
          enqueueDeferredTerminalAction(applyStartedEvent);
          return;
        }
        applyStartedEvent();
        return;
      }

      if (event.type === "cleared") {
        const applyClearedEvent = () => {
          const latestTerminal = terminalRef.current;
          if (!latestTerminal) {
            return;
          }
          clearSelectionAction();
          latestTerminal.clear();
          latestTerminal.write("\u001bc");
          handleSessionEvent(event);
        };
        if (outputWriteInFlightRef.current || hasQueuedXtermOutput(pendingOutputQueue)) {
          enqueueDeferredTerminalAction(applyClearedEvent);
          return;
        }
        applyClearedEvent();
        return;
      }

      if (event.type === "error") {
        const applyErrorEvent = () => {
          const latestTerminal = terminalRef.current;
          if (!latestTerminal) {
            return;
          }
          writeSystemMessage(latestTerminal, event.message);
          handleSessionEvent(event);
        };
        if (outputWriteInFlightRef.current || hasQueuedXtermOutput(pendingOutputQueue)) {
          enqueueDeferredTerminalAction(applyErrorEvent);
          return;
        }
        applyErrorEvent();
        return;
      }

      const applyExitEvent = () => {
        const latestTerminal = terminalRef.current;
        if (!latestTerminal) {
          return;
        }
        writeSystemMessage(latestTerminal, describeTerminalExit(event));
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
      if (outputWriteInFlightRef.current || hasQueuedXtermOutput(pendingOutputQueue)) {
        enqueueDeferredTerminalAction(applyExitEvent);
        return;
      }
      applyExitEvent();
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

    const unsubscribeTerminalEvents = useDirectEventSubscription
      ? directEventSubscription((event) => {
          if (!terminalHydratedRef.current) {
            return;
          }
          applyTerminalEvent(event);
        })
      : subscribeToEventEntries((nextEntries, previousEntries) => {
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

    const openTerminal = async () => {
      try {
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        terminalHydratedRef.current = false;
        clearScheduledOutputFlush();
        clearXtermOutputBatchQueue(pendingOutputQueue);
        outputWriteInFlightRef.current = false;
        deferredTerminalActionsRef.current = [];
        activeFitAddon.fit();
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
          ...(command ? { command } : {}),
        });
        if (disposed) return;
        writeTerminalSnapshot(activeTerminal, snapshot);
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
            activeTerminal.focus();
          });
        }
      } catch (err) {
        if (disposed) return;
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
        handleOpenError(err instanceof Error ? err.message : "Failed to open terminal");
      }
    };

    const fitTimer = window.setTimeout(() => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      if (!terminalHydratedRef.current) {
        return;
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        })
        .catch(() => undefined);
    }, 30);
    void openTerminal();

    return () => {
      disposed = true;
      terminalHydratedRef.current = false;
      lastAppliedTerminalEventIdRef.current = 0;
      unsubscribeTerminalEvents();
      window.clearTimeout(fitTimer);
      clearScheduledOutputFlush();
      clearXtermOutputBatchQueue(pendingOutputQueue);
      outputWriteInFlightRef.current = false;
      deferredTerminalActionsRef.current = [];
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      webglAddonCleanup?.();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    command,
    cwd,
    eventEntriesSelector,
    eventStoreSubscribe,
    eventSubscription,
    runtimeEnv,
    terminalId,
    threadId,
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
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
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
  }, [drawerHeight, resizeEpoch, terminalId, threadId]);

  useEffect(() => {
    const container = containerRef.current;
    const api = readNativeApi();
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

      const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
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
  }, [terminalId, threadId]);

  useEffect(() => {
    if (restartToken === 0) {
      return;
    }

    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        terminalHydratedRef.current = false;
        clearScheduledOutputFlush();
        clearXtermOutputBatchQueue(pendingOutputQueueRef.current);
        outputWriteInFlightRef.current = false;
        deferredTerminalActionsRef.current = [];
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
      className="relative h-full w-full overflow-hidden rounded-[4px]"
    />
  );
}
