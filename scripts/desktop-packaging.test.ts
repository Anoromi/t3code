import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("desktop packaging and launch wiring", () => {
  it("declares Nix desktop package, app checks, and Home Manager module outputs", () => {
    const flake = readRepoFile("flake.nix");

    expect(flake).toContain("nix/packages/desktop.nix");
    expect(flake).toContain("packages = forEachSystem mkPackages");
    expect(flake).toContain("checks = forEachSystem");
    expect(flake).toContain("homeManagerModules.default");
    expect(flake).toContain("default = desktop");
  });

  it("wires Home Manager package, local launcher source, and desktop entry installation", () => {
    const module = readRepoFile("nix/modules/home-manager.nix");

    expect(module).toContain("defaultDesktopPackage = self.packages.${system}.desktop");
    expect(module).toContain("local.configFile");
    expect(module).toContain("repoPath");
    expect(module).toContain("share/applications");
    expect(module).toContain("home.packages = [ cfg.package switchPackage localPackage ]");
  });

  it("keeps local desktop launch scripts explicit and user-path agnostic", () => {
    const runLocal = readRepoFile("scripts/run-local-desktop.sh");
    const hypr = readRepoFile("scripts/dev-desktop-wayland-hypr.sh");
    const launcher = readRepoFile("scripts/local-desktop-launch.ts");

    expect(runLocal).toContain('TERM="xterm-256color"');
    expect(runLocal).toContain("unset IN_NIX_SHELL");
    expect(runLocal).toContain("node scripts/local-desktop-launch.ts --repo-root");
    expect(runLocal).not.toContain("/home/");

    expect(launcher).toContain(
      '"bun", "install", "--frozen-lockfile", "--linker=hoisted", "--ignore-scripts"',
    );
    expect(launcher).toContain('"bun", "run", "--cwd", "apps/web", "build"');
    expect(launcher).toContain('"bun", "run", "--cwd", "apps/server", "build"');
    expect(launcher).toContain('"bun", "run", "--cwd", "apps/desktop", "build"');
    expect(launcher).toContain("const desktopStartCommand = [");
    expect(launcher).toContain('"apps/desktop"');
    expect(launcher).toContain('"start"');
    expect(launcher).not.toContain("/home/");

    expect(hypr).toContain("T3CODE_HYPR_WORKSPACE=$workspace");
    expect(hypr).toContain("bun run dev:desktop:wayland");
    expect(hypr).toContain("hypr-worktree.ts");
    expect(hypr).not.toContain("/home/");
  });
});
