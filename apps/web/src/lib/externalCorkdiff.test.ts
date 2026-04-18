import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveExternalCorkdiffConnection } from "./externalCorkdiff";

type TestWindow = {
  location: URL;
  desktopBridge?: DesktopBridge;
};

function installTestBrowser(url: string): TestWindow {
  const testWindow: TestWindow = {
    location: new URL(url),
  };
  vi.stubGlobal("window", testWindow);
  return testWindow;
}

describe("resolveExternalCorkdiffConnection", () => {
  beforeEach(() => {
    installTestBrowser("http://localhost/");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("mints a websocket token for external Corkdiff launches", async () => {
    const issueWebSocketToken = vi.fn().mockResolvedValue("issued-ws-token");

    await expect(
      resolveExternalCorkdiffConnection({
        wsBaseUrl: "ws://127.0.0.1:3773/ws?token=legacy-token",
        httpBaseUrl: "http://127.0.0.1:3773",
        issueWebSocketToken,
      }),
    ).resolves.toEqual({
      serverUrl: "ws://127.0.0.1:3773/ws?wsToken=issued-ws-token",
      token: null,
    });

    expect(issueWebSocketToken).toHaveBeenCalledWith("http://127.0.0.1:3773");
  });

  it("uses the Vite proxy origin when minting desktop websocket tokens in local dev", async () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");
    const testWindow = installTestBrowser("http://127.0.0.1:5733/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:13773",
        wsBaseUrl: "ws://127.0.0.1:13773/ws",
      }),
    } as DesktopBridge;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ token: "issued-ws-token" }), {
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveExternalCorkdiffConnection({
        wsBaseUrl: "ws://127.0.0.1:13773/ws",
        httpBaseUrl: "http://127.0.0.1:13773",
      }),
    ).resolves.toEqual({
      serverUrl: "ws://127.0.0.1:13773/ws?wsToken=issued-ws-token",
      token: null,
    });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:5733/api/auth/ws-token", {
      credentials: "include",
      method: "POST",
    });
  });

  it("keeps an existing websocket token without issuing a new one", async () => {
    const issueWebSocketToken = vi.fn().mockResolvedValue("unused-token");

    await expect(
      resolveExternalCorkdiffConnection({
        wsBaseUrl: "ws://127.0.0.1:3773/ws?wsToken=existing-token",
        httpBaseUrl: "http://127.0.0.1:3773",
        issueWebSocketToken,
      }),
    ).resolves.toEqual({
      serverUrl: "ws://127.0.0.1:3773/ws?wsToken=existing-token",
      token: null,
    });

    expect(issueWebSocketToken).not.toHaveBeenCalled();
  });

  it("falls back to legacy token environment wiring when HTTP bootstrap is unavailable", async () => {
    await expect(
      resolveExternalCorkdiffConnection({
        wsBaseUrl: "ws://127.0.0.1:3773/ws?token=legacy-token",
        httpBaseUrl: null,
      }),
    ).resolves.toEqual({
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "legacy-token",
    });
  });
});
