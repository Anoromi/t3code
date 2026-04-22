import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { launchDesktopE2eProcess } from "./fixtures/electronApp.js";

const require = createRequire(import.meta.url);
const electronExecutablePath = require("electron") as string;
const desktopDir = path.resolve(import.meta.dirname, "..");
const mainPath = path.join(desktopDir, "dist-electron", "main.cjs");

function launchSecondaryDesktopProcess(input: {
  readonly repoDir: string;
  readonly t3Home: string;
  readonly port: number;
  readonly backendCommand: string;
}): {
  readonly childProcess: ChildProcess;
  readonly logs: () => string;
} {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let output = "";
  const childProcess = spawn(electronExecutablePath, [mainPath], {
    cwd: desktopDir,
    env: {
      ...env,
      T3CODE_HOME: input.t3Home,
      T3CODE_PORT: String(input.port),
      T3CODE_E2E_FAKE_PROVIDER: "1",
      T3CODE_E2E_BACKEND_CWD: input.repoDir,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
      T3CODE_NODE_EXECUTABLE: input.backendCommand,
      VITE_DEV_SERVER_URL: "",
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childProcess.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  childProcess.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  return {
    childProcess,
    logs: () => output,
  };
}

async function waitForProcessExit(input: {
  readonly childProcess: ChildProcess;
  readonly logs: () => string;
}): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  const { childProcess } = input;
  if (childProcess.exitCode !== null) {
    return { code: childProcess.exitCode, signal: childProcess.signalCode };
  }

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for secondary desktop process to exit.\n${input.logs()}`),
      );
    }, 10_000);
    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
      clearTimeout(timeout);
      resolve();
    };
    childProcess.once("exit", handleExit);
    if (childProcess.exitCode !== null) {
      childProcess.off("exit", handleExit);
      handleExit(childProcess.exitCode, childProcess.signalCode);
    }
  });

  return { code: exitCode, signal: exitSignal };
}

async function createNeverReadyBackendExecutable(): Promise<{
  readonly command: string;
  readonly cleanup: () => Promise<void>;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "t3code-desktop-e2e-backend-"));
  const command = path.join(tempDir, "never-ready-backend");
  await fs.writeFile(
    command,
    [
      "#!/usr/bin/env node",
      'process.on("SIGTERM", () => process.exit(0));',
      'process.on("SIGINT", () => process.exit(0));',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    command,
    cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
  };
}

test("first launch opens a window and second launch focuses the daemon-owned window", async () => {
  const backend = await createNeverReadyBackendExecutable();
  const first = await launchDesktopE2eProcess({
    extraEnv: {
      T3CODE_NODE_EXECUTABLE: backend.command,
    },
  });
  let second: ReturnType<typeof launchSecondaryDesktopProcess> | null = null;

  try {
    const firstWindow = await first.app.firstWindow({ timeout: 5_000 });
    await expect(firstWindow.locator("body")).toBeVisible();
    await expect.poll(() => first.app.windows().length).toBe(1);

    second = launchSecondaryDesktopProcess({
      repoDir: first.repoDir,
      t3Home: first.t3Home,
      port: first.port,
      backendCommand: backend.command,
    });
    const secondExit = await waitForProcessExit(second);

    await expect.poll(() => first.app.windows().length).toBe(1);
    await expect(firstWindow.locator("body")).toBeVisible();
    expect(secondExit.code ?? secondExit.signal).not.toBeNull();
    first.expectNoFatalLogs();
  } finally {
    second?.childProcess.kill("SIGKILL");
    await first.cleanup();
    await backend.cleanup();
  }
});
