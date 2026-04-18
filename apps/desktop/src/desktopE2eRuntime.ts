import * as Path from "node:path";

const BACKEND_CHILD_ENV_KEYS = [
  "T3CODE_PORT",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_HOST",
  "T3CODE_DESKTOP_WS_URL",
  "T3CODE_DESKTOP_LAN_ACCESS",
  "T3CODE_DESKTOP_LAN_HOST",
] as const;

export function isDesktopE2eMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.T3CODE_E2E_FAKE_PROVIDER === "1";
}

export function sanitizeBackendChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of BACKEND_CHILD_ENV_KEYS) {
    delete sanitized[key];
  }

  if (sanitized.VITE_DEV_SERVER_URL?.trim() === "") {
    delete sanitized.VITE_DEV_SERVER_URL;
  }

  return sanitized;
}

export function resolveBackendCwdForEnv(
  env: NodeJS.ProcessEnv,
  resolveFallbackCwd: () => string,
): string {
  const e2eBackendCwd = env.T3CODE_E2E_BACKEND_CWD?.trim();
  if (isDesktopE2eMode(env) && e2eBackendCwd) {
    return Path.resolve(e2eBackendCwd);
  }

  return resolveFallbackCwd();
}
