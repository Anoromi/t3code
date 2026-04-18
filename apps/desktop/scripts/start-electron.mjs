import { spawn } from "node:child_process";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";
import { resolveDesktopOzoneArgs, resolveDesktopProfileArgs } from "./runtime-args.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(
  resolveElectronPath(),
  [
    ...resolveDesktopOzoneArgs(childEnv),
    ...resolveDesktopProfileArgs(childEnv),
    "dist-electron/main.cjs",
  ],
  {
    stdio: "inherit",
    cwd: desktopDir,
    env: childEnv,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
