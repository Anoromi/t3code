import { readFile } from "node:fs/promises";

export const T3CODE_LOCAL_LAUNCH_ENV_FILE = "T3CODE_LOCAL_LAUNCH_ENV_FILE";

export function parseNullDelimitedEnvSnapshot(contents: Buffer | string): NodeJS.ProcessEnv {
  const text = typeof contents === "string" ? contents : contents.toString("utf8");
  const environment: NodeJS.ProcessEnv = {};

  for (const entry of text.split("\0")) {
    if (entry.length === 0) {
      continue;
    }

    const separatorIndex = entry.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = entry.slice(0, separatorIndex);
    if (key.length === 0) {
      continue;
    }

    environment[key] = entry.slice(separatorIndex + 1);
  }

  return environment;
}

export function serializeEnvSnapshot(env: NodeJS.ProcessEnv): Buffer {
  const serialized = Object.entries(env)
    .flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]))
    .join("\0");
  return Buffer.from(`${serialized}\0`, "utf8");
}

export async function readLaunchEnvSnapshotFromFile(
  filePath: string | undefined,
): Promise<NodeJS.ProcessEnv | null> {
  const normalizedPath = filePath?.trim();
  if (!normalizedPath) {
    return null;
  }

  try {
    const contents = await readFile(normalizedPath);
    return parseNullDelimitedEnvSnapshot(contents);
  } catch {
    return null;
  }
}

function shouldPreserveCurrentEnvKey(key: string, preserveKeys: readonly string[]): boolean {
  if (preserveKeys.includes(key)) {
    return true;
  }

  return (
    key === "IN_NIX_SHELL" ||
    key === "SSL_CERT_DIR" ||
    key === "SSL_CERT_FILE" ||
    key.startsWith("NIX_") ||
    key.startsWith("OPENSSL") ||
    key.startsWith("PKG_CONFIG")
  );
}

export function mergeAppRuntimeEnv(input: {
  launchEnv: NodeJS.ProcessEnv;
  currentEnv: NodeJS.ProcessEnv;
  preserveKeys: readonly string[];
}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...input.launchEnv };

  for (const [key, value] of Object.entries(input.currentEnv)) {
    if (!shouldPreserveCurrentEnvKey(key, input.preserveKeys)) {
      continue;
    }

    if (value !== undefined) {
      merged[key] = value;
    }
  }

  for (const key of input.preserveKeys) {
    const value = input.currentEnv[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
}
