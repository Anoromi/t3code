import { spawn } from "node:child_process";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";
import { resolveDesktopOzoneArgs, resolveDesktopProfileArgs } from "./runtime-args.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const electronCommand = resolveElectronLaunchCommand(childEnv);

const child = spawn(
  electronCommand.command,
  [
    ...electronCommand.argsPrefix,
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
