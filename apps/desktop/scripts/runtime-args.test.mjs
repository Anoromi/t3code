import { describe, expect, it } from "vitest";

import { resolveDesktopOzoneArgs, resolveDesktopOzoneEnv } from "./runtime-args.mjs";

describe("desktop runtime args", () => {
  it("adds explicit Wayland ozone args and Electron hint env", () => {
    const env = { T3CODE_DESKTOP_OZONE_PLATFORM: "wayland" };
    const expectedArgs =
      process.platform === "linux"
        ? [
            "--enable-features=UseOzonePlatform",
            "--ozone-platform-hint=wayland",
            "--ozone-platform=wayland",
          ]
        : [];
    const expectedEnv =
      process.platform === "linux"
        ? { ELECTRON_OZONE_PLATFORM_HINT: "wayland", NIXOS_OZONE_WL: "1" }
        : {};

    expect(resolveDesktopOzoneArgs(env)).toEqual(expectedArgs);
    expect(resolveDesktopOzoneEnv(env)).toEqual(expectedEnv);
  });

  it("does not emit ozone args for invalid values", () => {
    const env = { T3CODE_DESKTOP_OZONE_PLATFORM: "mir" };

    expect(resolveDesktopOzoneArgs(env)).toEqual([]);
    expect(resolveDesktopOzoneEnv(env)).toEqual({});
  });

  it("honors Electron and NixOS Wayland hints when the T3 env is absent", () => {
    const expectedArgs =
      process.platform === "linux"
        ? [
            "--enable-features=UseOzonePlatform",
            "--ozone-platform-hint=wayland",
            "--ozone-platform=wayland",
          ]
        : [];

    expect(resolveDesktopOzoneArgs({ ELECTRON_OZONE_PLATFORM_HINT: "wayland" })).toEqual(
      expectedArgs,
    );
    expect(resolveDesktopOzoneArgs({ NIXOS_OZONE_WL: "1" })).toEqual(expectedArgs);
  });
});
