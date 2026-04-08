import { describe, expect, it, vi } from "vitest";

import { fixPath } from "./os-jank";

describe("fixPath", () => {
  it("hydrates PATH on linux using the resolved login shell", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/nix/store/hash-bash-5.3/bin/bash",
      PATH: "/usr/bin",
    };
    const readPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");

    fixPath({
      env,
      platform: "linux",
      readPath,
    });

    expect(readPath).toHaveBeenCalledWith("/run/current-system/sw/bin/bash");
    expect(env.SHELL).toBe("/run/current-system/sw/bin/bash");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("does nothing outside macOS and linux even when SHELL is set", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
    };
    const readPath = vi.fn(() => "/usr/local/bin:/usr/bin");

    fixPath({
      env,
      platform: "win32",
      readPath,
    });

    expect(readPath).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });
});
