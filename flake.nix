{
  description = "T3 Code flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = lib.genAttrs systems;
      mkPkgs =
        system:
        import nixpkgs { inherit system; };
      mkSrc =
        system:
        import ./nix/lib/source.nix {
          lib = (mkPkgs system).lib;
          src = ./.;
        };
      mkPackages =
        system:
        let
          pkgs = mkPkgs system;
          cleanSrc = mkSrc system;
          bunConfig = import ./nix/bun.nix;
          nodeModules = pkgs.callPackage ./nix/lib/node-modules.nix {
            src = cleanSrc;
            inherit bunConfig;
          };
          desktop = pkgs.callPackage ./nix/packages/desktop.nix {
            src = cleanSrc;
            inherit nodeModules;
          };
        in
        {
          inherit desktop;
          default = desktop;
        };
    in
    {
      packages = forEachSystem mkPackages;

      checks = forEachSystem (system: {
        desktop = self.packages.${system}.desktop;
      });

      homeManagerModules.default = import ./nix/modules/home-manager.nix { inherit self; };
    };
}
