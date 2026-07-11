import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_PROJECT_HYPRNAV_SETTINGS,
  type EnvironmentId,
  type DesktopHyprnavSyncInput,
  type ProjectHyprnavAction,
  type ProjectHyprnavBinding,
  type ProjectHyprnavOverride,
  type ProjectHyprnavScope,
  type ProjectHyprnavSettings,
  type ProjectHyprnavWorkspaceTarget,
  type ProjectId,
} from "@t3tools/contracts";
import { AlertTriangleIcon, MinusIcon, PlusIcon, RouteIcon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  useClientSettingsHydrated,
  usePersistClientSettings,
  usePrimarySettings,
} from "../../hooks/useSettings";
import { useProject } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildProjectHyprnavSyncJobs,
  computeClearedHyprnavBindingNames,
  computeRemovedHyprnavBindings,
  HYPRNAV_ACTION_ROWS,
  HYPRNAV_SCOPE_ROWS,
  HYPRNAV_WORKSPACE_ROWS,
  findHyprnavActionLabel,
  findHyprnavScopeLabel,
  findHyprnavWorkspaceLabel,
  resolveProjectHyprnavSettings,
  validateProjectHyprnavSettings,
} from "../../hyprnavSettings";
import { publishHyprnavRequests } from "../../hyprnavRuntime";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { useProjects, useThreadShells } from "../../state/entities";
import { primaryServerAvailableEditorsAtom } from "../../state/server";
import type { Project, ThreadShell } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export type HyprnavDraftBinding = {
  readonly id: string;
  readonly slot: string;
  readonly scope: ProjectHyprnavScope;
  readonly workspaceMode: ProjectHyprnavWorkspaceTarget["mode"];
  readonly workspaceId: string;
  readonly name: string;
  readonly action: ProjectHyprnavAction;
  readonly command: string;
};

export function hyprnavDraftFromSettings(settings: ProjectHyprnavSettings): HyprnavDraftBinding[] {
  return settings.bindings.map((binding) => ({
    id: binding.id,
    slot: String(binding.slot),
    scope: binding.scope,
    workspaceMode: binding.workspace.mode,
    workspaceId: binding.workspace.mode === "absolute" ? String(binding.workspace.workspaceId) : "",
    name: binding.name ?? "",
    action: binding.action,
    command: binding.action === "shell-command" ? binding.command : "",
  }));
}

export function parseHyprnavDraft(draft: readonly HyprnavDraftBinding[]): {
  readonly settings: ProjectHyprnavSettings | null;
  readonly message: string | null;
} {
  const bindings: ProjectHyprnavBinding[] = [];
  for (const item of draft) {
    const slot = Number(item.slot);
    if (!Number.isInteger(slot) || slot < 1) {
      return { settings: null, message: "Every slot must be a positive whole number." };
    }
    const workspace =
      item.workspaceMode === "managed"
        ? ({ mode: "managed" } as const)
        : Number.isInteger(Number(item.workspaceId)) && Number(item.workspaceId) >= 1
          ? ({ mode: "absolute", workspaceId: Number(item.workspaceId) } as const)
          : null;
    if (!workspace) {
      return { settings: null, message: "Absolute workspaces need a positive workspace number." };
    }
    if (item.name.trim().length > 255) {
      return { settings: null, message: "Binding names must be 255 characters or fewer." };
    }
    const common = {
      id: item.id,
      slot,
      scope: item.scope,
      workspace,
      ...(item.name.trim() ? { name: item.name.trim() } : {}),
    };
    bindings.push(
      item.action === "shell-command"
        ? { ...common, action: "shell-command", command: item.command.trim() }
        : { ...common, action: item.action },
    );
  }

  const settings: ProjectHyprnavSettings = { bindings };
  const validation = validateProjectHyprnavSettings(settings);
  if (validation.duplicateScopedSlots.length > 0) {
    return { settings: null, message: "Each scope can use a slot only once." };
  }
  if (validation.emptyShellCommandBindingIds.length > 0) {
    return { settings: null, message: "Shell command bindings need a command." };
  }
  return { settings, message: null };
}

export function resolveProjectHyprnavNextOverride(input: {
  readonly parsedSettings: ProjectHyprnavSettings;
  readonly defaultProjectHyprnavSettings: ProjectHyprnavSettings;
  readonly forceInherited: boolean;
}): ProjectHyprnavOverride {
  if (
    input.forceInherited ||
    JSON.stringify(input.parsedSettings) === JSON.stringify(input.defaultProjectHyprnavSettings)
  ) {
    return null;
  }
  return input.parsedSettings;
}

export function buildHyprnavPublicationRequests(input: {
  readonly localEnvironmentId: EnvironmentId;
  readonly projects: readonly (Project & { readonly nextHyprnav: ProjectHyprnavSettings })[];
  readonly threadShells: readonly ThreadShell[];
  readonly previousSettingsByProjectKey: ReadonlyMap<string, ProjectHyprnavSettings>;
}): DesktopHyprnavSyncInput[] {
  const clearBindingsByProjectKey = new Map(
    input.projects.map((project) => {
      const key = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
      return [
        key,
        computeRemovedHyprnavBindings(
          input.previousSettingsByProjectKey.get(key),
          project.nextHyprnav,
        ),
      ] as const;
    }),
  );
  const clearNamesByProjectKey = new Map(
    input.projects.map((project) => {
      const key = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
      return [
        key,
        computeClearedHyprnavBindingNames(
          input.previousSettingsByProjectKey.get(key),
          project.nextHyprnav,
        ),
      ] as const;
    }),
  );

  return buildProjectHyprnavSyncJobs({
    localEnvironmentId: input.localEnvironmentId,
    projects: input.projects.map((project) => ({ ...project, hyprnav: project.nextHyprnav })),
    threadShells: input.threadShells,
    activeThread: null,
    clearBindingsByProjectKey,
    clearNamesByProjectKey,
  }).map((job) => ({
    projectRoot: job.projectRoot,
    worktreePath: job.worktreePath,
    threadId: job.threadId,
    threadTitle: job.threadTitle,
    hyprnav: job.hyprnav,
    clearBindings: job.clearBindings,
    clearNames: job.clearNames,
    lock: job.lock,
  }));
}

export async function publishSettingsChange(input: {
  readonly localEnvironmentId: EnvironmentId | null;
  readonly projects: readonly (Project & { readonly nextHyprnav: ProjectHyprnavSettings })[];
  readonly threadShells: readonly ThreadShell[];
  readonly previousSettingsByProjectKey: ReadonlyMap<string, ProjectHyprnavSettings>;
  readonly availableEditors: Parameters<typeof resolveAndPersistPreferredEditor>[0];
  readonly publish?: typeof publishHyprnavRequests;
}): Promise<string> {
  if (input.localEnvironmentId === null || input.projects.length === 0) {
    return "Saved. Runtime synchronization is limited to the primary local environment.";
  }
  try {
    const requests = buildHyprnavPublicationRequests({
      localEnvironmentId: input.localEnvironmentId,
      projects: input.projects,
      threadShells: input.threadShells,
      previousSettingsByProjectKey: input.previousSettingsByProjectKey,
    });
    const result = await (input.publish ?? publishHyprnavRequests)({
      requests,
      availableEditors: input.availableEditors,
      resolvePreferredEditor: resolveAndPersistPreferredEditor,
    });
    return result.status === "ok"
      ? "Saved and synchronized with Hyprnav."
      : `Saved, but Hyprnav was not applied. ${result.message ?? "The desktop runtime will retry later."}`;
  } catch (error) {
    return `Saved, but Hyprnav was not applied. ${
      error instanceof Error ? error.message : "The desktop runtime will retry later."
    }`;
  }
}

function nextBinding(draft: readonly HyprnavDraftBinding[]): HyprnavDraftBinding {
  const used = new Set(draft.map((item) => Number(item.slot)));
  let slot = 1;
  while (used.has(slot)) slot += 1;
  return {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    slot: String(slot),
    scope: "worktree",
    workspaceMode: "managed",
    workspaceId: "",
    name: "",
    action: "shell-command",
    command: "",
  };
}

function runtimeStatusMessage(runtimeEligible = true): string {
  if (!runtimeEligible) {
    return "Saved. Runtime synchronization is limited to the primary local environment.";
  }
  if (typeof window === "undefined" || !window.desktopBridge) {
    return "Saved. Hyprnav applies only in the local desktop environment.";
  }
  if (typeof window.desktopBridge.syncHyprnavEnvironment !== "function") {
    return "Saved, but the Hyprnav desktop runtime is unavailable. T3 Code will retry after it becomes available.";
  }
  return "Saved. The desktop runtime will synchronize these bindings.";
}

function BindingEditor({
  binding,
  disabled,
  onChange,
  onRemove,
}: {
  readonly binding: HyprnavDraftBinding;
  readonly disabled: boolean;
  readonly onChange: (next: HyprnavDraftBinding) => void;
  readonly onRemove: () => void;
}) {
  const patch = (value: Partial<HyprnavDraftBinding>) => onChange({ ...binding, ...value });
  return (
    <div className="border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5">
      <div className="grid gap-3 lg:grid-cols-[5rem_9rem_10rem_minmax(0,1fr)_auto] lg:items-end">
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Slot
          <Input
            aria-label={`Slot for ${binding.name || binding.id}`}
            inputMode="numeric"
            value={binding.slot}
            disabled={disabled}
            onChange={(event) => patch({ slot: event.target.value })}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Scope
          <Select
            value={binding.scope}
            disabled={disabled}
            onValueChange={(value) => patch({ scope: value as ProjectHyprnavScope })}
          >
            <SelectTrigger aria-label={`Scope for ${binding.name || binding.id}`}>
              <SelectValue>{findHyprnavScopeLabel(binding.scope)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {HYPRNAV_SCOPE_ROWS.map((row) => (
                <SelectItem key={row.key} value={row.key}>
                  {row.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Workspace
          <Select
            value={binding.workspaceMode}
            disabled={disabled}
            onValueChange={(value) =>
              patch({ workspaceMode: value as ProjectHyprnavWorkspaceTarget["mode"] })
            }
          >
            <SelectTrigger aria-label={`Workspace for ${binding.name || binding.id}`}>
              <SelectValue>{findHyprnavWorkspaceLabel(binding.workspaceMode)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {HYPRNAV_WORKSPACE_ROWS.map((row) => (
                <SelectItem key={row.key} value={row.key}>
                  {row.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Action
          <Select
            value={binding.action}
            disabled={disabled}
            onValueChange={(value) => patch({ action: value as ProjectHyprnavAction })}
          >
            <SelectTrigger aria-label={`Action for ${binding.name || binding.id}`}>
              <SelectValue>{findHyprnavActionLabel(binding.action)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {HYPRNAV_ACTION_ROWS.map((row) => (
                <SelectItem key={row.key} value={row.key}>
                  {row.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${binding.name || binding.id}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <MinusIcon className="size-4" />
        </Button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Name
          <Input
            aria-label={`Name for ${binding.id}`}
            placeholder="Optional Hyprnav label"
            maxLength={255}
            value={binding.name}
            disabled={disabled}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>
        {binding.workspaceMode === "absolute" ? (
          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            Workspace number
            <Input
              aria-label={`Absolute workspace for ${binding.name || binding.id}`}
              inputMode="numeric"
              value={binding.workspaceId}
              disabled={disabled}
              onChange={(event) => patch({ workspaceId: event.target.value })}
            />
          </label>
        ) : null}
        {binding.action === "shell-command" ? (
          <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
            Command
            <Input
              aria-label={`Command for ${binding.name || binding.id}`}
              className="font-mono text-xs"
              placeholder="Command executed by hyprnav"
              value={binding.command}
              disabled={disabled}
              onChange={(event) => patch({ command: event.target.value })}
            />
          </label>
        ) : null}
      </div>
    </div>
  );
}

export function HyprnavEditor({
  title,
  description,
  initialSettings,
  inherited,
  disabled,
  onSave,
  onReset,
}: {
  readonly title: string;
  readonly description: string;
  readonly initialSettings: ProjectHyprnavSettings;
  readonly inherited: boolean;
  readonly disabled: boolean;
  readonly onSave: (settings: ProjectHyprnavSettings) => Promise<string>;
  readonly onReset: (() => Promise<string>) | null;
}) {
  const [draft, setDraft] = useState(() => hyprnavDraftFromSettings(initialSettings));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const parsed = useMemo(() => parseHyprnavDraft(draft), [draft]);
  const statusIsWarning =
    status?.includes("not applied") === true || status?.includes("unavailable") === true;

  useEffect(() => {
    setDraft(hyprnavDraftFromSettings(initialSettings));
    setStatus(null);
  }, [initialSettings]);

  const updateBinding = useCallback((index: number, next: HyprnavDraftBinding) => {
    setDraft((current) => current.map((item, itemIndex) => (itemIndex === index ? next : item)));
  }, []);

  const save = async () => {
    if (!parsed.settings) return;
    setBusy(true);
    try {
      setStatus(await onSave(parsed.settings));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save Hyprnav settings.");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!onReset) return;
    setBusy(true);
    try {
      setStatus(await onReset());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not reset Hyprnav settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title={title}
        icon={<RouteIcon className="size-3.5" />}
        headerAction={
          inherited ? (
            <span className="text-[11px] text-muted-foreground">Using global defaults</span>
          ) : null
        }
      >
        <div className="border-b border-border/60 px-4 py-3.5 sm:px-5">
          <p className="max-w-[70ch] text-xs text-muted-foreground/80">{description}</p>
        </div>
        {draft.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">
            No bindings. Add one to assign a Hyprnav slot.
          </div>
        ) : (
          draft.map((binding, index) => (
            <BindingEditor
              key={binding.id}
              binding={binding}
              disabled={disabled || busy}
              onChange={(next) => updateBinding(index, next)}
              onRemove={() =>
                setDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))
              }
            />
          ))
        )}
        <div className="flex flex-col gap-2 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => setDraft((current) => [...current, nextBinding(current)])}
          >
            <PlusIcon className="size-3.5" />
            Add binding
          </Button>
          <div className="flex flex-1 items-center gap-2 text-xs">
            {parsed.message ? (
              <span className="inline-flex items-center gap-1.5 text-destructive">
                <AlertTriangleIcon className="size-3.5" />
                {parsed.message}
              </span>
            ) : status ? (
              <span
                className={
                  statusIsWarning
                    ? "inline-flex items-center gap-1.5 text-warning"
                    : "text-muted-foreground"
                }
              >
                {statusIsWarning ? <AlertTriangleIcon className="size-3.5" /> : null}
                {status}
              </span>
            ) : null}
          </div>
          {onReset ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={() => void reset()}
            >
              Use defaults
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={() => setDraft(hyprnavDraftFromSettings(DEFAULT_PROJECT_HYPRNAV_SETTINGS))}
            >
              Reset built-ins
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            aria-label="Save and apply"
            disabled={disabled || busy || !parsed.settings}
            onClick={() => void save()}
          >
            <SaveIcon className="size-3.5" />
            Save and apply
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function HyprnavDefaultsSettingsPanel() {
  const hydrated = useClientSettingsHydrated();
  const settings = usePrimarySettings((value) => value.defaultProjectHyprnavSettings);
  const persistSettings = usePersistClientSettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const projects = useProjects();
  const threadShells = useThreadShells();
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);

  return (
    <HyprnavEditor
      title="Hyprnav defaults"
      description="Bindings apply to local desktop projects unless a project has its own override. Project, worktree, and thread scopes may reuse the same slot."
      initialSettings={settings}
      inherited={false}
      disabled={!hydrated}
      onReset={null}
      onSave={async (next) => {
        await persistSettings({ defaultProjectHyprnavSettings: next });
        const localProjects = projects
          .filter(
            (project) =>
              project.environmentId === primaryEnvironment?.environmentId &&
              (project.hyprnav === null || project.hyprnav === undefined),
          )
          .map((project) => ({ ...project, nextHyprnav: next }));
        return publishSettingsChange({
          localEnvironmentId: primaryEnvironment?.environmentId ?? null,
          projects: localProjects,
          threadShells,
          previousSettingsByProjectKey: new Map(
            localProjects.map((project) => [
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
              settings,
            ]),
          ),
          availableEditors,
        });
      }}
    />
  );
}

export function ProjectHyprnavSettingsPanel({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const hydrated = useClientSettingsHydrated();
  const defaults = usePrimarySettings((value) => value.defaultProjectHyprnavSettings);
  const primaryEnvironment = usePrimaryEnvironment();
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const threadShells = useThreadShells();
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const effectiveSettings = resolveProjectHyprnavSettings(project?.hyprnav, defaults);
  const inherited = project?.hyprnav === null || project?.hyprnav === undefined;

  if (!project) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Hyprnav project">
          <div className="px-5 py-8 text-sm text-muted-foreground">Project not found.</div>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const persist = async (hyprnav: ProjectHyprnavOverride) => {
    const previousSettings = effectiveSettings;
    const nextSettings = resolveProjectHyprnavSettings(hyprnav, defaults);
    const result = await updateProject({
      environmentId,
      input: { projectId, hyprnav },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        throw new Error("Project settings save was interrupted.");
      }
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error("Could not save project settings.");
    }
    if (primaryEnvironment?.environmentId !== environmentId) {
      return runtimeStatusMessage(false);
    }
    return publishSettingsChange({
      localEnvironmentId: environmentId,
      projects: [{ ...project, nextHyprnav: nextSettings }],
      threadShells: threadShells.filter(
        (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
      ),
      previousSettingsByProjectKey: new Map([
        [scopedProjectKey(scopeProjectRef(environmentId, projectId)), previousSettings],
      ]),
      availableEditors,
    });
  };

  return (
    <HyprnavEditor
      title={project.title}
      description={`Hyprnav bindings for ${project.workspaceRoot}. Saving an override affects only this project entry.`}
      initialSettings={effectiveSettings}
      inherited={inherited}
      disabled={!hydrated}
      onReset={() => persist(null)}
      onSave={(next) =>
        persist(
          resolveProjectHyprnavNextOverride({
            parsedSettings: next,
            defaultProjectHyprnavSettings: defaults,
            forceInherited: false,
          }),
        )
      }
    />
  );
}
