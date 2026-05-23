import { describe, expect, it } from "vitest";

const repoRootUrl = new URL("../", import.meta.url);

async function readRepoFile(relativePath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(relativePath, repoRootUrl), "utf8");
}

async function listWorkspacePackageDirs(): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const packageJson = JSON.parse(await readRepoFile("package.json")) as {
    workspaces?: { packages?: string[] };
  };
  const dirs = new Set<string>();

  for (const pattern of packageJson.workspaces?.packages ?? []) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      const entries = await fs.readdir(new URL(`${parent}/`, repoRootUrl), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const relativePath = `${parent}/${entry.name}`;
        try {
          await fs.access(new URL(path.posix.join(relativePath, "package.json"), repoRootUrl));
          dirs.add(relativePath);
        } catch {
          // Non-package directories under a workspace glob are ignored by package managers.
        }
      }
    } else {
      dirs.add(pattern);
    }
  }

  return [...dirs].toSorted();
}

describe("workflow configuration", () => {
  it("keeps release workflow wired for desktop artifact publishing", async () => {
    const workflow = await readRepoFile(".github/workflows/release.yml");

    expect(workflow).toContain("dist:desktop");
    expect(workflow).toContain("dist:desktop:artifact");
    expect(workflow).toContain("AppImage");
  });

  it("passes desktop Wayland runtime env through Turbo", async () => {
    const turbo = JSON.parse(await readRepoFile("turbo.json")) as {
      globalEnv?: ReadonlyArray<string>;
    };
    const packageJson = JSON.parse(await readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(turbo.globalEnv).toEqual(
      expect.arrayContaining([
        "T3CODE_DESKTOP_OZONE_PLATFORM",
        "ELECTRON_OZONE_PLATFORM_HINT",
        "NIXOS_OZONE_WL",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE",
        "HYPRLAND_INSTANCE_SIGNATURE",
        "DISPLAY",
      ]),
    );
    expect(packageJson.scripts?.["dev:desktop:wayland"]).toContain(
      "node scripts/dev-runner.ts dev:desktop",
    );
    expect(packageJson.scripts?.["dev:desktop:wayland"]).not.toContain("bun dev:desktop");
  });

  it("keeps the fork Home Manager option namespace as programs.t3cork", async () => {
    const module = await readRepoFile("nix/modules/home-manager.nix");

    expect(module).toContain("cfg = config.programs.t3cork");
    expect(module).toContain("options.programs.t3cork");
    expect(module).not.toContain("options.programs.t3code");
  });

  it("derives Nix node_modules workspace handling from package.json", async () => {
    const workspaceDirs = await listWorkspacePackageDirs();
    const nodeModulesDerivation = await readRepoFile("nix/lib/node-modules.nix");
    const desktopDerivation = await readRepoFile("nix/packages/desktop.nix");
    const updateScript = await readRepoFile("scripts/update-bun2nix.sh");

    expect(workspaceDirs).toContain("oxlint-plugin-t3code");
    expect(nodeModulesDerivation).toContain("import ./workspaces.nix");
    expect(desktopDerivation).toContain("import ../lib/workspaces.nix");
    expect(desktopDerivation).toContain('case "$workspace_dir" in');
    expect(desktopDerivation).not.toContain("cp -a oxlint-plugin-t3code");
    expect(updateScript).toContain("packageJson.workspaces?.packages");
    expect(updateScript).not.toContain("workspace_dirs=(");
    expect(`${nodeModulesDerivation}\n${desktopDerivation}`).not.toContain(
      "apps/desktop apps/marketing apps/server apps/web",
    );
  });
});
