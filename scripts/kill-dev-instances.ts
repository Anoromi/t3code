#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";

const TERM_GRACE_MS = 1_500;
const DEV_ROOT_MARKER = "--t3code-dev-root=";
const DEV_COMMAND_MARKERS = [
  "scripts/dev-runner.ts dev",
  "scripts/dev-runner.ts dev:",
  "apps/desktop/scripts/dev-electron.mjs",
] as const;
const EXCLUDED_COMMAND_MARKERS = [
  "scripts/kill-dev-instances.ts",
  "t3code-local",
  "T3 Code Local",
  "t3code.desktop",
  "com.t3tools.t3code ",
] as const;

class KillDevInstancesError extends Data.TaggedError("KillDevInstancesError")<{
  readonly message: string;
}> {}

export interface ProcessSnapshotEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface KillSelection {
  readonly rootPids: ReadonlyArray<number>;
  readonly pids: ReadonlyArray<number>;
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseProcessSnapshot(stdout: string): ReadonlyArray<ProcessSnapshotEntry> {
  return stdout
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return [];
      }

      const [, pidText, ppidText, command = ""] = match;
      if (pidText === undefined || ppidText === undefined) {
        return [];
      }

      const pid = parsePositiveInteger(pidText);
      const ppid = parsePositiveInteger(ppidText);
      if (pid === null || ppid === null) {
        return [];
      }

      return [
        {
          pid,
          ppid,
          command,
        },
      ];
    })
    .filter((entry) => entry.pid !== process.pid);
}

function isExcludedCommand(command: string): boolean {
  return EXCLUDED_COMMAND_MARKERS.some((marker) => command.includes(marker));
}

function isDevT3CodeRootCommand(command: string): boolean {
  if (isExcludedCommand(command)) {
    return false;
  }

  return (
    command.includes(DEV_ROOT_MARKER) ||
    DEV_COMMAND_MARKERS.some((marker) => command.includes(marker))
  );
}

function collectDescendants(
  rootPid: number,
  childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>,
): ReadonlyArray<number> {
  const descendants: number[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];

  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined) {
      continue;
    }

    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }

  return descendants;
}

export function selectDevT3CodeProcesses(
  entries: ReadonlyArray<ProcessSnapshotEntry>,
): KillSelection {
  const childrenByParent = new Map<number, Array<number>>();
  for (const entry of entries) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.ppid, children);
  }

  const rootPids = entries
    .filter((entry) => isDevT3CodeRootCommand(entry.command))
    .map((entry) => entry.pid)
    .toSorted((left, right) => left - right);

  const selected = new Set<number>();
  for (const rootPid of rootPids) {
    selected.add(rootPid);
    for (const descendantPid of collectDescendants(rootPid, childrenByParent)) {
      selected.add(descendantPid);
    }
  }

  return {
    rootPids,
    pids: [...selected].toSorted((left, right) => right - left),
  };
}

const loadProcessSnapshot = Effect.fn("loadProcessSnapshot")(function* () {
  const child = yield* ChildProcess.make("ps", ["-eo", "pid=,ppid=,args="]);
  const stdout = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new KillDevInstancesError({ message: `ps exited with code ${exitCode}` });
  }
  return parseProcessSnapshot(stdout);
});

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

function killPids(pids: ReadonlyArray<number>): Effect.Effect<void> {
  for (const pid of pids) {
    signalPid(pid, "SIGTERM");
  }

  return Effect.sleep(`${TERM_GRACE_MS} millis`).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        for (const pid of pids) {
          signalPid(pid, "SIGKILL");
        }
      }),
    ),
  );
}

function parseArgs(argv: ReadonlyArray<string>): { readonly dryRun: boolean } {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

const main = Effect.fn("main")(function* () {
  const options = parseArgs(process.argv.slice(2));
  const entries = yield* loadProcessSnapshot();
  const selection = selectDevT3CodeProcesses(entries);

  if (selection.pids.length === 0) {
    yield* Effect.logInfo("[kill-dev] no dev T3 Code processes found");
    return;
  }

  yield* Effect.logInfo(
    `[kill-dev] ${options.dryRun ? "would kill" : "killing"} ${selection.pids.length} process(es) from root pid(s): ${selection.rootPids.join(", ")}`,
  );

  if (options.dryRun) {
    for (const entry of entries.filter((entry) => selection.pids.includes(entry.pid))) {
      yield* Effect.logInfo(`[kill-dev] pid=${entry.pid} ppid=${entry.ppid} ${entry.command}`);
    }
    return;
  }

  yield* killPids(selection.pids);
});

if (import.meta.main) {
  main().pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
