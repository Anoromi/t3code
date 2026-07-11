import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";

import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import { resolveActiveHyprnavSyncTarget, resolveProjectHyprnavSettings } from "../hyprnavSettings";
import {
  createCancelableHyprnavDelay,
  hyprnavCredentialRefreshDelay,
  publishHyprnavRequests,
  resolveHyprnavCorkdiffConnection,
} from "../hyprnavRuntime";
import { usePrimaryEnvironment } from "../state/environments";
import { useProject, useThreadShell } from "../state/entities";
import { primaryServerAvailableEditorsAtom } from "../state/server";
import { toastManager } from "./ui/toast";

const HYPRNAV_BACKGROUND_RETRY_DELAY_MS = 5_000;

export function HyprnavRuntimeOrchestrator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const primaryEnvironment = usePrimaryEnvironment();
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const defaults = useClientSettings((settings) => settings.defaultProjectHyprnavSettings);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const effectiveSettings = useMemo(
    () => resolveProjectHyprnavSettings(project?.hyprnav, defaults),
    [defaults, project?.hyprnav],
  );
  const target = useMemo(
    () =>
      resolveActiveHyprnavSyncTarget({
        localEnvironmentId: primaryEnvironment?.environmentId,
        activeThread: thread,
        project,
      }),
    [primaryEnvironment?.environmentId, project, thread],
  );
  const requestKey =
    target === null
      ? null
      : JSON.stringify({
          target,
          settings: effectiveSettings,
          availableEditors,
        });

  useEffect(() => {
    if (!isElectron || !target || !requestKey) return;

    let cancelled = false;
    let warned = false;
    const delay = createCancelableHyprnavDelay();
    const credentialRefreshDelay = hyprnavCredentialRefreshDelay(effectiveSettings);
    void (async () => {
      for (;;) {
        if (cancelled) return;
        try {
          const result = await publishHyprnavRequests({
            requests: [
              {
                projectRoot: target.projectRoot,
                worktreePath: target.worktreePath,
                threadId: target.threadId,
                threadTitle: target.threadTitle,
                hyprnav: effectiveSettings,
                clearBindings: [],
                clearNames: [],
                lock: true,
              },
            ],
            availableEditors,
            resolvePreferredEditor: resolveAndPersistPreferredEditor,
            ...(credentialRefreshDelay !== null
              ? { resolveCorkdiffConnection: resolveHyprnavCorkdiffConnection }
              : {}),
          });
          if (cancelled) return;
          if (result.status === "ok") {
            if (credentialRefreshDelay === null) return;
            await delay.wait(credentialRefreshDelay);
            continue;
          }
          if (!warned) {
            warned = true;
            toastManager.add({
              type: "warning",
              title: "Hyprnav sync failed",
              description: result.message ?? "Hyprnav could not sync the active worktree.",
            });
          }
        } catch (error) {
          if (cancelled) return;
          if (!warned) {
            warned = true;
            toastManager.add({
              type: "warning",
              title: "Hyprnav sync failed",
              description:
                error instanceof Error
                  ? error.message
                  : "Hyprnav could not sync the active worktree.",
            });
          }
        }
        await delay.wait(HYPRNAV_BACKGROUND_RETRY_DELAY_MS);
      }
    })();

    return () => {
      cancelled = true;
      delay.cancel();
    };
  }, [availableEditors, effectiveSettings, requestKey, target]);

  return null;
}
