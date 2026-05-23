import { assert, describe, it } from "@effect/vitest";

import { parseProcessSnapshot, selectDevT3CodeProcesses } from "./kill-dev-instances.ts";

describe("kill-dev-instances", () => {
  it("parses ps pid parent and command rows", () => {
    const entries = parseProcessSnapshot(`
      101       1 node scripts/dev-runner.ts dev:desktop
      102     101 turbo run dev --filter=@t3tools/desktop
`);

    assert.deepStrictEqual(entries, [
      {
        pid: 101,
        ppid: 1,
        command: "node scripts/dev-runner.ts dev:desktop",
      },
      {
        pid: 102,
        ppid: 101,
        command: "turbo run dev --filter=@t3tools/desktop",
      },
    ]);
  });

  it("selects dev roots and their descendants", () => {
    const selection = selectDevT3CodeProcesses([
      { pid: 101, ppid: 1, command: "node scripts/dev-runner.ts dev" },
      { pid: 102, ppid: 101, command: "turbo run dev --parallel" },
      { pid: 103, ppid: 102, command: "vite --host localhost" },
      { pid: 201, ppid: 1, command: "electron --t3code-dev-root=/repo/apps/desktop" },
      { pid: 202, ppid: 201, command: "/repo/apps/server/dist/bin.mjs" },
      { pid: 301, ppid: 1, command: "t3code" },
    ]);

    assert.deepStrictEqual(selection.rootPids, [101, 201]);
    assert.deepStrictEqual(selection.pids, [202, 201, 103, 102, 101]);
  });

  it("does not select local or installed t3code launchers", () => {
    const selection = selectDevT3CodeProcesses([
      { pid: 101, ppid: 1, command: "t3code-local" },
      { pid: 102, ppid: 1, command: "T3 Code Local" },
      { pid: 103, ppid: 1, command: "/nix/store/app/bin/t3code" },
      { pid: 104, ppid: 1, command: "electron --desktop-entry=t3code.desktop" },
    ]);

    assert.deepStrictEqual(selection.rootPids, []);
    assert.deepStrictEqual(selection.pids, []);
  });
});
