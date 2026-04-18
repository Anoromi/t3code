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

    expect(runLocal).toContain("bun install --frozen-lockfile");
    expect(runLocal).toContain("bun run --cwd apps/web build");
    expect(runLocal).toContain("bun run build:desktop");
    expect(runLocal).toContain("bun run --cwd apps/desktop start");
    expect(runLocal).not.toContain("/home/");

    expect(hypr).toContain("T3CODE_HYPR_WORKSPACE=$workspace");
    expect(hypr).toContain("bun run dev:desktop:wayland");
    expect(hypr).toContain("hypr-worktree.ts");
    expect(hypr).not.toContain("/home/");
  });
});
