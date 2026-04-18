import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDesktopDaemonPaths } from "@t3tools/shared/desktopDaemon";
import { acquireDesktopDaemonController } from "./desktopDaemon.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "t3code-desktop-daemon-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => FS.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("desktopDaemon controller", () => {
  it("becomes primary when no daemon owns the state dir", async () => {
    const stateDir = await createTempDir();
    const controller = await acquireDesktopDaemonController({
      paths: resolveDesktopDaemonPaths(stateDir),
      onFocus: vi.fn(),
    });

    expect(controller.kind).toBe("primary");
    if (controller.kind === "primary") {
      await controller.close();
    }
  });

  it("focuses the existing daemon instead of becoming primary", async () => {
    const stateDir = await createTempDir();
    const paths = resolveDesktopDaemonPaths(stateDir);
    const onFocus = vi.fn();

    const primary = await acquireDesktopDaemonController({
      paths,
      onFocus,
    });

    expect(primary.kind).toBe("primary");
    const secondary = await acquireDesktopDaemonController({
      paths,
      onFocus: vi.fn(),
    });

    expect(secondary.kind).toBe("secondary");
    expect(onFocus).toHaveBeenCalledTimes(1);

    if (primary.kind === "primary") {
      await primary.close();
    }
  });
});
