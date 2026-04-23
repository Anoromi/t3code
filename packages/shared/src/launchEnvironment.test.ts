import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  mergeAppRuntimeEnv,
  parseNullDelimitedEnvSnapshot,
  readLaunchEnvSnapshotFromFile,
  serializeEnvSnapshot,
  T3CODE_LOCAL_LAUNCH_ENV_FILE,
} from "./launchEnvironment.ts";

const createdTempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("launchEnvironment", () => {
  it("parses NUL-delimited snapshots and preserves values", () => {
    const parsed = parseNullDelimitedEnvSnapshot(
      Buffer.from("PATH=/usr/bin\0MULTILINE=line-1\nline-2\0KEY=value\0", "utf8"),
    );

    expect(parsed).toEqual({
      PATH: "/usr/bin",
      MULTILINE: "line-1\nline-2",
      KEY: "value",
    });
  });

  it("ignores malformed entries and uses the last duplicate value", () => {
    const parsed = parseNullDelimitedEnvSnapshot("BAD\0KEY=first\0=missing\0KEY=second\0");

    expect(parsed).toEqual({
      KEY: "second",
    });
  });

  it("serializes and deserializes snapshots round-trip", () => {
    const serialized = serializeEnvSnapshot({
      PATH: "/usr/bin:/bin",
      MULTILINE: "line-1\nline-2",
      OMITTED: undefined,
    });

    expect(parseNullDelimitedEnvSnapshot(serialized)).toEqual({
      PATH: "/usr/bin:/bin",
      MULTILINE: "line-1\nline-2",
    });
  });

  it("reads a launch env snapshot from disk", async () => {
    const tempDir = await createTempDir("launch-env-");
    const snapshotPath = path.join(tempDir, "launch.env");
    await writeFile(
      snapshotPath,
      serializeEnvSnapshot({ PATH: "/usr/bin", SSL_CERT_FILE: "/etc/ssl/cert.pem" }),
    );

    await expect(readLaunchEnvSnapshotFromFile(snapshotPath)).resolves.toEqual({
      PATH: "/usr/bin",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
    });
  });

  it("returns null for missing snapshot files", async () => {
    await expect(
      readLaunchEnvSnapshotFromFile("/tmp/does-not-exist-launch-env"),
    ).resolves.toBeNull();
    await expect(readLaunchEnvSnapshotFromFile(undefined)).resolves.toBeNull();
  });

  it("preserves runtime env keys needed by the current app process", () => {
    const merged = mergeAppRuntimeEnv({
      launchEnv: {
        PATH: "/home/user/.cargo/bin:/usr/bin",
        PKG_CONFIG_PATH: "/home/user/.local/lib/pkgconfig",
        OPENSSL_DIR: "/home/user/.local/openssl",
        SSL_CERT_FILE: "/home/user/.local/certs.pem",
      },
      currentEnv: {
        PATH: "/nix/store/bun/bin:/usr/bin",
        PKG_CONFIG_PATH: "/nix/store/openssl/lib/pkgconfig",
        OPENSSL_DIR: "/nix/store/openssl-dev",
        SSL_CERT_FILE: "/nix/store/cacert/etc/ssl/certs/ca-bundle.crt",
        IN_NIX_SHELL: "impure",
        NIX_PROFILES: "/nix/var/nix/profiles/default",
        [T3CODE_LOCAL_LAUNCH_ENV_FILE]: "/tmp/t3code-launch-env",
        T3CODE_HOME: "/home/user/.t3",
      },
      preserveKeys: [T3CODE_LOCAL_LAUNCH_ENV_FILE, "T3CODE_HOME"],
    });

    expect(merged).toEqual({
      PATH: "/home/user/.cargo/bin:/usr/bin",
      PKG_CONFIG_PATH: "/nix/store/openssl/lib/pkgconfig",
      OPENSSL_DIR: "/nix/store/openssl-dev",
      SSL_CERT_FILE: "/nix/store/cacert/etc/ssl/certs/ca-bundle.crt",
      IN_NIX_SHELL: "impure",
      NIX_PROFILES: "/nix/var/nix/profiles/default",
      [T3CODE_LOCAL_LAUNCH_ENV_FILE]: "/tmp/t3code-launch-env",
      T3CODE_HOME: "/home/user/.t3",
    });
  });
});
