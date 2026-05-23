import { describe, expect, it, vi } from "vitest";

import { configureDevBackendProxy, isDevProxyPath, resolveDevProxyTarget } from "../vite.config";

describe("dev backend proxy helpers", () => {
  it("resolves websocket URLs to backend HTTP targets", () => {
    expect(resolveDevProxyTarget("ws://127.0.0.1:5734/ws?token=secret")).toBe(
      "http://127.0.0.1:5734/",
    );
    expect(resolveDevProxyTarget("wss://example.test/socket")).toBe("https://example.test/");
    expect(resolveDevProxyTarget("not a url")).toBeUndefined();
  });

  it("matches only backend proxy routes", () => {
    expect(isDevProxyPath("/api/config")).toBe(true);
    expect(isDevProxyPath("/attachments/file.png")).toBe(true);
    expect(isDevProxyPath("/.well-known/t3/daemon.json")).toBe(true);
    expect(isDevProxyPath("/src/main.tsx")).toBe(false);
    expect(isDevProxyPath("/threads/thread-id")).toBe(false);
  });

  it("turns proxy connection failures into readiness responses", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    configureDevBackendProxy({
      on: (event, listener) => {
        listeners.set(event, listener as (...args: unknown[]) => void);
      },
    });

    const writeHead = vi.fn();
    const end = vi.fn();
    listeners.get("error")?.(new Error("ECONNREFUSED"), {}, { writeHead, end });

    expect(writeHead).toHaveBeenCalledWith(503, { "content-type": "application/json" });
    expect(end).toHaveBeenCalledWith(JSON.stringify({ error: "T3 backend is not ready." }));
  });
});
