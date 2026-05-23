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
          inherit desktop nodeModules;
          default = desktop;
        };
      mkDevShell =
        system:
        let
          pkgs = mkPkgs system;
          runtimeLibraries = with pkgs; [
            alsa-lib
            atk
            at-spi2-atk
            at-spi2-core
            cairo
            cups
            dbus
            expat
            glib
            gtk3
            libdrm
            libgbm
            libnotify
            libsecret
            libx11
            libxcomposite
            libxdamage
            libxext
            libxfixes
            libxrandr
            libxcb
            libxkbcommon
            nspr
            nss
            pango
            systemd
          ];
        in
        {
          default = pkgs.mkShell {
            packages =
              with pkgs;
              [
                bashInteractive
                bun
                git
                jq
                nodejs_24
                openssl
                pkg-config
                python3
              ]
              ++ runtimeLibraries;

            env = {
              npm_config_nodedir = pkgs.nodejs_24;
              OPENSSL_DIR = "${pkgs.openssl.dev}";
              OPENSSL_INCLUDE_DIR = "${pkgs.openssl.dev}/include";
              OPENSSL_LIB_DIR = "${pkgs.openssl.out}/lib";
            };
          };
        };
    in
    {
      packages = forEachSystem mkPackages;
      devShells = forEachSystem mkDevShell;

      checks = forEachSystem (system: {
        desktop = self.packages.${system}.desktop;
      });

      homeManagerModules.default = import ./nix/modules/home-manager.nix { inherit self; };
    };
}
