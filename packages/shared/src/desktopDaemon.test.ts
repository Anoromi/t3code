import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readDesktopDaemonRecord,
  resolveDesktopDaemonPaths,
  resolveDesktopStateDir,
  writeDesktopDaemonRecord,
} from "./desktopDaemon.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "t3code-daemon-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => FS.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("desktopDaemon helpers", () => {
  it("resolves state dir overrides and default paths", () => {
    expect(
      resolveDesktopStateDir({
        baseDir: "/tmp/base",
      }),
    ).toBe(Path.join("/tmp/base", "userdata"));

    expect(
      resolveDesktopStateDir({
        baseDir: "/tmp/base",
        stateDirOverride: " /tmp/custom-state ",
      }),
    ).toBe("/tmp/custom-state");
  });

  it("resolves daemon paths for unix and windows", () => {
    expect(resolveDesktopDaemonPaths("/tmp/state", "linux")).toEqual({
      stateDir: "/tmp/state",
      daemonDir: "/tmp/state/daemon",
      recordPath: "/tmp/state/daemon/desktop.json",
      controlEndpoint: "/tmp/state/daemon/desktop.sock",
    });

    const windowsPaths = resolveDesktopDaemonPaths("C:\\tmp\\state", "win32");
    expect(windowsPaths.recordPath.endsWith("daemon/desktop.json")).toBe(true);
    expect(windowsPaths.controlEndpoint).toMatch(/^\\\\\.\\pipe\\t3code-desktop-[0-9a-f]{16}$/);
  });

  it("writes and reads daemon records atomically", async () => {
    const stateDir = await createTempDir();
    const paths = resolveDesktopDaemonPaths(stateDir, "linux");

    await writeDesktopDaemonRecord(
      paths,
      {
        version: 1,
        kind: "desktop",
        instanceId: "instance-1",
        pid: process.pid,
        startedAt: "2026-04-13T12:00:00.000Z",
        baseDir: stateDir,
        stateDir,
        wsUrl: "ws://127.0.0.1:4444/?token=secret",
        authToken: "secret",
        controlEndpoint: paths.controlEndpoint,
        status: "starting",
      },
      "linux",
    );

    await expect(readDesktopDaemonRecord(paths.recordPath)).resolves.toEqual({
      version: 1,
      kind: "desktop",
      instanceId: "instance-1",
      pid: process.pid,
      startedAt: "2026-04-13T12:00:00.000Z",
      baseDir: stateDir,
      stateDir,
      wsUrl: "ws://127.0.0.1:4444/?token=secret",
      authToken: "secret",
      controlEndpoint: paths.controlEndpoint,
      status: "starting",
    });
  });
});
