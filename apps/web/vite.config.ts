import * as Fs from "node:fs";
import * as Net from "node:net";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const configuredWsUrl = process.env.VITE_WS_URL?.trim();
const configuredHostedAppChannel = process.env.VITE_HOSTED_APP_CHANNEL?.trim() || "";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const configuredHostedAppUrl = (() => {
  const explicitHostedAppUrl = process.env.VITE_HOSTED_APP_URL?.trim();
  if (explicitHostedAppUrl) {
    return explicitHostedAppUrl;
  }
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return undefined;
})();
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();
const canonicalIndexPath = fileURLToPath(new URL("./index.html", import.meta.url));
const impeccableDevIndexPath = fileURLToPath(new URL("./index.impeccable.html", import.meta.url));
const IMPECCABLE_LIVE_MARKER = "impeccable-live-start";

const buildSourcemap =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

export function resolveDevProxyTarget(wsUrl: string | undefined): string | undefined {
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const devProxyTarget = resolveDevProxyTarget(configuredWsUrl);
const DEV_BACKEND_READINESS_CACHE_MS = 250;
const DEV_BACKEND_READINESS_TIMEOUT_MS = 100;
const DEV_PROXY_PATH_PREFIXES = ["/.well-known", "/api", "/attachments"] as const;

export function isDevProxyPath(url: string | undefined): boolean {
  return DEV_PROXY_PATH_PREFIXES.some((prefix) => url?.startsWith(prefix));
}

function probeTcpEndpoint(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = Net.createConnection({ host: hostname, port });
    let settled = false;

    const finish = (ready: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(ready);
    };

    socket.setTimeout(DEV_BACKEND_READINESS_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export function createDevBackendReadinessProbe(target: string | undefined): () => Promise<boolean> {
  if (!target) {
    return () => Promise.resolve(false);
  }

  const targetUrl = new URL(target);
  const port = Number.parseInt(targetUrl.port, 10) || (targetUrl.protocol === "https:" ? 443 : 80);
  let cachedAt = 0;
  let cachedReady = false;

  return async () => {
    const now = Date.now();
    if (now - cachedAt < DEV_BACKEND_READINESS_CACHE_MS) {
      return cachedReady;
    }

    cachedReady = await probeTcpEndpoint(targetUrl.hostname, port);
    cachedAt = Date.now();
    return cachedReady;
  };
}

const isDevBackendReady = createDevBackendReadinessProbe(devProxyTarget);

function devBackendReadinessMiddleware(): Plugin {
  return {
    name: "t3-dev-backend-readiness",
    configureServer(server) {
      if (!devProxyTarget) {
        return;
      }

      server.middlewares.use((req, res, next) => {
        if (!isDevProxyPath(req.url)) {
          next();
          return;
        }

        void isDevBackendReady().then((ready) => {
          if (ready) {
            next();
            return;
          }

          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "T3 backend is not ready." }));
        }, next);
      });
    },
  };
}

export function configureDevBackendProxy(proxy: {
  on: (event: "error", listener: (error: Error, req: unknown, res: unknown) => void) => void;
}): void {
  proxy.on("error", (_error, _req, res) => {
    if (
      !res ||
      typeof res !== "object" ||
      !("writeHead" in res) ||
      !("end" in res) ||
      typeof res.writeHead !== "function" ||
      typeof res.end !== "function"
    ) {
      return;
    }

    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "T3 backend is not ready." }));
  });
}

function ensureImpeccableDevIndex(): void {
  if (
    Fs.existsSync(impeccableDevIndexPath) &&
    Fs.readFileSync(impeccableDevIndexPath, "utf8").includes(IMPECCABLE_LIVE_MARKER)
  ) {
    return;
  }

  Fs.copyFileSync(canonicalIndexPath, impeccableDevIndexPath);
}

function shouldServeImpeccableDevIndex(
  url: string | undefined,
  acceptHeader: string | undefined,
): boolean {
  const pathname = url?.split("?", 1)[0] ?? "/";
  const acceptsHtml = acceptHeader?.includes("text/html") ?? false;
  if (
    pathname.startsWith("/@") ||
    pathname.startsWith("/src/") ||
    pathname.startsWith("/node_modules/") ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/.well-known") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/attachments/")
  ) {
    return false;
  }

  // In dev, every app navigation route should receive the Impeccable-injected
  // HTML file. Vite internals, source modules, assets, and backend proxy paths
  // must still pass through unchanged or the app cannot boot.
  if (pathname === "/" || pathname === "/index.html") {
    return true;
  }

  if (Path.extname(pathname) === "") {
    return true;
  }

  return acceptsHtml;
}

function impeccableDevIndexMiddleware(): Plugin {
  return {
    name: "t3-impeccable-dev-index",
    apply: "serve",
    configureServer(server) {
      ensureImpeccableDevIndex();
      server.watcher.add(impeccableDevIndexPath);
      server.watcher.on("change", (changedPath) => {
        if (Path.resolve(changedPath) !== impeccableDevIndexPath) {
          return;
        }

        server.ws.send({ type: "full-reload", path: "*" });
      });

      server.middlewares.use((req, res, next) => {
        const acceptHeader = req.headers.accept;
        if (!shouldServeImpeccableDevIndex(req.url, acceptHeader)) {
          next();
          return;
        }

        Fs.readFile(impeccableDevIndexPath, "utf8", (error, html) => {
          if (error) {
            next();
            return;
          }

          void server.transformIndexHtml(req.url ?? "/", html).then((transformedHtml) => {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html");
            res.end(transformedHtml);
          }, next);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [
    tanstackRouter(),
    react(),
    babel({
      // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
      // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
      // whereas the previous version of the plugin parsed all files with a .ts extension.
      // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
    devBackendReadinessMiddleware(),
    impeccableDevIndexMiddleware(),
  ],
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "effect/Array",
      "effect/Order",
    ],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
    "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
    "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(configuredHostedAppChannel),
    "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port,
    strictPort: true,
    ...(devProxyTarget
      ? {
          proxy: {
            "/.well-known": {
              target: devProxyTarget,
              changeOrigin: true,
              configure: configureDevBackendProxy,
            },
            "/api": {
              target: devProxyTarget,
              changeOrigin: true,
              configure: configureDevBackendProxy,
            },
            "/attachments": {
              target: devProxyTarget,
              changeOrigin: true,
              configure: configureDevBackendProxy,
            },
          },
        }
      : {}),
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
  },
});
