import { describe, expect, it } from "vitest";

import {
  isDesktopE2eMode,
  resolveBackendCwdForEnv,
  sanitizeBackendChildEnv,
} from "./desktopE2eRuntime.ts";

describe("desktopE2eRuntime", () => {
  it("enables E2E mode only for the explicit fake provider flag", () => {
    expect(isDesktopE2eMode({ T3CODE_E2E_FAKE_PROVIDER: "1" })).toBe(true);
    expect(isDesktopE2eMode({ T3CODE_E2E_FAKE_PROVIDER: "true" })).toBe(false);
    expect(isDesktopE2eMode({})).toBe(false);
  });

  it("strips desktop-injected backend env and blank dev server URLs", () => {
    const sanitized = sanitizeBackendChildEnv({
      T3CODE_PORT: "13773",
      T3CODE_MODE: "web",
      T3CODE_NO_BROWSER: "1",
      T3CODE_HOST: "0.0.0.0",
      T3CODE_DESKTOP_WS_URL: "ws://localhost:13773",
      T3CODE_DESKTOP_LAN_ACCESS: "1",
      T3CODE_DESKTOP_LAN_HOST: "host.local",
      VITE_DEV_SERVER_URL: "   ",
      KEEP_ME: "yes",
    });

    expect(sanitized).toEqual({ KEEP_ME: "yes" });
  });

  it("keeps non-empty dev server URLs for development backend launches", () => {
    expect(
      sanitizeBackendChildEnv({
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
      }).VITE_DEV_SERVER_URL,
    ).toBe("http://127.0.0.1:5733");
  });

  it("uses the E2E backend cwd only in fake provider mode", () => {
    expect(
      resolveBackendCwdForEnv(
        {
          T3CODE_E2E_FAKE_PROVIDER: "1",
          T3CODE_E2E_BACKEND_CWD: "/tmp/e2e-repo",
        },
        () => "/fallback",
      ),
    ).toBe("/tmp/e2e-repo");

    expect(
      resolveBackendCwdForEnv(
        {
          T3CODE_E2E_BACKEND_CWD: "/tmp/e2e-repo",
        },
        () => "/fallback",
      ),
    ).toBe("/fallback");
  });
});
