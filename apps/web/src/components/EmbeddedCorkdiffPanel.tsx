import {
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { RotateCcwIcon, TerminalSquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";

import { useCorkdiffStateStore } from "../corkdiffStateStore";
import { CORKDIFF_TERMINAL_ID } from "../lib/corkdiffTerminal";
import { getTerminalEventBus } from "../lib/terminalEventBus";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import XtermTerminalViewport from "./XtermTerminalViewport";

function normalizeDesktopWsUrl(rawUrl: string | null): {
  serverUrl: string | null;
  token: string | null;
} {
  if (!rawUrl) {
    return { serverUrl: null, token: null };
  }

  try {
    const parsed = new URL(rawUrl);
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");
    const search = parsed.searchParams.toString();
    parsed.search = search.length > 0 ? `?${search}` : "";
    return { serverUrl: parsed.toString(), token };
  } catch {
    return { serverUrl: rawUrl, token: null };
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "exited":
      return "Exited";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function statusClassName(status: string): string {
  switch (status) {
    case "running":
      return "border-emerald-500/30 text-emerald-700 dark:text-emerald-300";
    case "starting":
      return "border-amber-500/30 text-amber-700 dark:text-amber-300";
    case "error":
      return "border-destructive/30 text-destructive";
    case "exited":
      return "border-border text-muted-foreground";
    default:
      return "border-border text-muted-foreground";
  }
}

interface EmbeddedCorkdiffPanelProps {
  threadId: ThreadId;
  visible: boolean;
  onClose: () => void;
  onAddTerminalContext?: (selection: TerminalContextSelection) => void;
}

export default function EmbeddedCorkdiffPanel({
  threadId,
  visible,
  onClose,
  onAddTerminalContext,
}: EmbeddedCorkdiffPanelProps) {
  const thread = useStore((store) => store.threads.find((entry) => entry.id === threadId));
  const project = useStore((store) =>
    thread ? store.projects.find((entry) => entry.id === thread.projectId) : undefined,
  );
  const threadState = useCorkdiffStateStore((store) => store.byThreadId[threadId]);
  const ensureThread = useCorkdiffStateStore((store) => store.ensureThread);
  const markLaunching = useCorkdiffStateStore((store) => store.markLaunching);
  const applySnapshot = useCorkdiffStateStore((store) => store.applySnapshot);
  const setError = useCorkdiffStateStore((store) => store.setError);
  const requestRestart = useCorkdiffStateStore((store) => store.requestRestart);
  const markBootstrapped = useCorkdiffStateStore((store) => store.markBootstrapped);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const bootstrappedRestartTokenRef = useRef<number | null>(
    threadState?.bootstrappedRestartToken ?? null,
  );

  const cwd = thread?.worktreePath ?? project?.cwd ?? null;
  const worktreePath = thread?.worktreePath ?? null;
  const rawWsUrl = window.desktopBridge?.getWsUrl?.() ?? null;
  const { serverUrl, token } = useMemo(() => normalizeDesktopWsUrl(rawWsUrl), [rawWsUrl]);

  useEffect(() => {
    ensureThread(threadId, cwd, worktreePath);
  }, [cwd, ensureThread, threadId, worktreePath]);

  useEffect(() => {
    bootstrappedRestartTokenRef.current = threadState?.bootstrappedRestartToken ?? null;
  }, [threadState?.bootstrappedRestartToken]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
    setFocusRequestId((value) => value + 1);
  }, [visible, threadId]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    if (!cwd) {
      setError(
        threadId,
        "No worktree or project directory is available for this thread.",
        cwd,
        worktreePath,
      );
      return;
    }
    if (!serverUrl) {
      setError(threadId, "The desktop websocket URL is unavailable.", cwd, worktreePath);
      return;
    }
    if (threadState?.launched) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setError(threadId, "The native terminal API is unavailable.", cwd, worktreePath);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        await api.terminal.close({
          threadId,
          terminalId: CORKDIFF_TERMINAL_ID,
          deleteHistory: true,
        });
      } catch {
        // Best-effort cleanup for stale sessions/history from previous implementations.
      }
      if (cancelled) {
        return;
      }
      markLaunching(threadId, cwd, worktreePath);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    cwd,
    markLaunching,
    serverUrl,
    setError,
    threadId,
    threadState?.launched,
    visible,
    worktreePath,
  ]);

  const runtimeEnv = useMemo(() => {
    if (!serverUrl) {
      return undefined;
    }
    return {
      T3CODE_SERVER_URL: serverUrl,
      ...(token ? { T3CODE_TOKEN: token } : {}),
    };
  }, [serverUrl, token]);

  const bootstrapCommand = useMemo(() => {
    if (!serverUrl) {
      return "";
    }

    const envParts = [`T3CODE_SERVER_URL=${quoteShellArg(serverUrl)}`];
    if (token) {
      envParts.push(`T3CODE_TOKEN=${quoteShellArg(token)}`);
    }

    return `clear && exec env ${envParts.join(" ")} nvim -c ${quoteShellArg(`CorkDiff t3code ${threadId}`)}\n`;
  }, [serverUrl, threadId, token]);

  const maybeBootstrapNeovim = useCallback(
    (snapshot: TerminalSessionSnapshot) => {
      if (snapshot.status !== "running") {
        return;
      }
      const restartToken = threadState?.restartToken ?? 0;
      if (bootstrappedRestartTokenRef.current === restartToken) {
        return;
      }

      const api = readNativeApi();
      if (!api) {
        setError(threadId, "The native terminal API is unavailable.", cwd, worktreePath);
        return;
      }

      bootstrappedRestartTokenRef.current = restartToken;
      markBootstrapped(threadId, restartToken);
      void api.terminal
        .write({
          threadId,
          terminalId: CORKDIFF_TERMINAL_ID,
          data: bootstrapCommand,
        })
        .then(() => {
          setResizeEpoch((value) => value + 1);
          setFocusRequestId((value) => value + 1);
        })
        .catch((error) => {
          bootstrappedRestartTokenRef.current = null;
          setError(
            threadId,
            error instanceof Error ? error.message : "Failed to start Neovim in Corkdiff terminal.",
            cwd,
            worktreePath,
          );
        });
    },
    [
      bootstrapCommand,
      cwd,
      markBootstrapped,
      setError,
      threadId,
      threadState?.restartToken,
      worktreePath,
    ],
  );

  const handleSnapshot = useCallback(
    (snapshot: TerminalSessionSnapshot) => {
      applySnapshot(threadId, snapshot);
      maybeBootstrapNeovim(snapshot);
    },
    [applySnapshot, maybeBootstrapNeovim, threadId],
  );
  const handleSessionEvent = useCallback(
    (event: TerminalEvent) => {
      if (event.type === "started" || event.type === "restarted") {
        maybeBootstrapNeovim(event.snapshot);
      }
    },
    [maybeBootstrapNeovim],
  );
  const handleOpenError = useCallback(
    (message: string) => {
      setError(threadId, message, cwd, worktreePath);
    },
    [cwd, setError, threadId, worktreePath],
  );
  const eventSubscription = useCallback(
    (listener: (event: TerminalEvent) => void) => {
      return getTerminalEventBus().subscribe(threadId, CORKDIFF_TERMINAL_ID, listener);
    },
    [threadId],
  );

  const launched = threadState?.launched ?? false;
  const canRenderTerminal = launched;

  return (
    <section
      data-terminal-surface="corkdiff"
      data-global-shortcuts="disabled"
      className={`thread-terminal-drawer absolute inset-0 z-20 isolate flex min-h-0 min-w-0 flex-col bg-background ${
        visible ? "pointer-events-auto" : "pointer-events-none invisible"
      }`}
      aria-hidden={!visible}
    >
      <div className="pointer-events-auto absolute right-3 top-3 z-50 flex items-center gap-2">
        <Badge
          variant="outline"
          className={`bg-background/95 backdrop-blur-sm ${statusClassName(threadState?.status ?? "idle")}`}
        >
          {statusLabel(threadState?.status ?? "idle")}
        </Badge>
        <div className="relative z-50 flex items-center gap-1 rounded-md border border-border bg-background/95 p-1 shadow-sm backdrop-blur-sm">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setFocusRequestId((value) => value + 1);
              setResizeEpoch((value) => value + 1);
            }}
            aria-label="Focus Corkdiff terminal"
          >
            <TerminalSquareIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => requestRestart(threadId)}
            aria-label="Restart Corkdiff"
          >
            <RotateCcwIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close Corkdiff"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {!cwd || !serverUrl ? (
          <div className="flex h-full items-start p-4">
            <div className="rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              {threadState?.lastError ?? "Unable to launch Corkdiff for this thread."}
            </div>
          </div>
        ) : null}
        {cwd && serverUrl && canRenderTerminal ? (
          <div className={`h-full ${visible ? "" : "hidden"}`}>
            <XtermTerminalViewport
              threadId={threadId}
              terminalId={CORKDIFF_TERMINAL_ID}
              terminalLabel="Corkdiff"
              cwd={cwd}
              worktreePath={worktreePath}
              {...(runtimeEnv ? { runtimeEnv } : {})}
              onSessionExited={() => undefined}
              onAddTerminalContext={onAddTerminalContext ?? (() => undefined)}
              onSessionSnapshot={handleSnapshot}
              onSessionEvent={handleSessionEvent}
              onOpenError={handleOpenError}
              eventSubscription={eventSubscription}
              focusRequestId={focusRequestId}
              autoFocus={visible}
              resizeEpoch={resizeEpoch}
              drawerHeight={0}
              restartToken={threadState?.restartToken ?? 0}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
