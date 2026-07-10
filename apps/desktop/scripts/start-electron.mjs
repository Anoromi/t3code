import * as NodeChildProcess from "node:child_process";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";
import { resolveDesktopOzoneArgs, resolveDesktopOzoneEnv } from "./runtime-args.mjs";

const childEnv = { ...process.env, ...resolveDesktopOzoneEnv(process.env) };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronCommand = resolveElectronLaunchCommand([
  ...resolveDesktopOzoneArgs(childEnv),
  ".",
  ...process.argv.slice(2),
]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
