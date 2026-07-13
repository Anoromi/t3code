import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const HELPER_PATH = NodeURL.fileURLToPath(
  new URL("../../../nix/local-launch-environment.sh", import.meta.url),
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

async function makeRuntimeDirectory() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-wrapper-env-"));
  temporaryDirectories.push(directory);
  return directory;
}

function launchCapture(script, runtimeDirectory) {
  return NodeChildProcess.spawn(
    "bash",
    ["-c", `source "$1"; ${script}`, "t3code-wrapper-test", HELPER_PATH],
    {
      env: {
        HOME: "/home/captured-user",
        PATH: process.env.PATH,
        SHELL: "/bin/bash",
        USER_MARKER: "captured-before-nix",
        XDG_RUNTIME_DIR: runtimeDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function readFirstLine(stream) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) resolve(buffered.slice(0, newline));
    });
    stream.once("error", reject);
    stream.once("end", () => reject(new Error("capture process exited before reporting its file")));
  });
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await NodeFSP.access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe("t3code-local environment capture", () => {
  it("creates a private pre-Nix snapshot and removes it after a failed launch", async () => {
    const runtimeDirectory = await makeRuntimeDirectory();
    const child = launchCapture(
      't3code_capture_local_launch_environment; printf "%s\\n" "$T3CODE_LOCAL_LAUNCH_ENV_FILE"; stat -c "%a" "$T3CODE_LOCAL_LAUNCH_ENV_FILE"; exit 47',
      runtimeDirectory,
    );
    const output = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => output.push(chunk));

    await expect(waitForExit(child)).resolves.toEqual({ code: 47, signal: null });
    const [snapshotPath, mode] = output.join("").trim().split("\n");
    expect(mode).toBe("600");
    await expect(NodeFSP.stat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the snapshot when the wrapper is interrupted", async () => {
    const runtimeDirectory = await makeRuntimeDirectory();
    const terminationMarker = NodePath.join(runtimeDirectory, "child-terminated");
    const readyMarker = NodePath.join(runtimeDirectory, "child-ready");
    const child = launchCapture(
      `t3code_capture_local_launch_environment; printf "%s\\n" "$T3CODE_LOCAL_LAUNCH_ENV_FILE"; t3code_run_local_launch bash -c 'trap '"'"'touch "$1"; exit 0'"'"' TERM; touch "$2"; while :; do :; done' child "${terminationMarker}" "${readyMarker}"`,
      runtimeDirectory,
    );
    const snapshotPath = await readFirstLine(child.stdout);
    const snapshot = await NodeFSP.readFile(snapshotPath);
    expect(snapshot.includes(Buffer.from("USER_MARKER=captured-before-nix\0"))).toBe(true);
    expect(snapshot.includes(Buffer.from("T3CODE_LOCAL_LAUNCH_ENV_FILE="))).toBe(false);
    await waitForPath(readyMarker);

    const exit = waitForExit(child);
    child.kill("SIGTERM");
    await expect(exit).resolves.toEqual({ code: 143, signal: null });
    await expect(NodeFSP.stat(terminationMarker)).resolves.toBeDefined();
    await expect(NodeFSP.stat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
