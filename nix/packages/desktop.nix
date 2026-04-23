{ lib, pkgs, src, nodeModules }:

let
  serverPackageJson = builtins.fromJSON (builtins.readFile ../../apps/server/package.json);
  electronPackage = pkgs.electron_40;
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
pkgs.stdenv.mkDerivation (finalAttrs: {
  pname = "t3-code";
  version = serverPackageJson.version;
  inherit src;

  nativeBuildInputs = with pkgs; [
    bun
    makeWrapper
    copyDesktopItems
    git
    nodejs_24
    openssl
    pkg-config
    python3
  ];

  buildInputs = runtimeLibraries ++ [ pkgs.openssl ];

  env = {
    npm_config_nodedir = pkgs.nodejs_24;
    OPENSSL_DIR = "${pkgs.openssl.dev}";
    OPENSSL_INCLUDE_DIR = "${pkgs.openssl.dev}/include";
    OPENSSL_LIB_DIR = "${pkgs.openssl.out}/lib";
  };

  desktopItems = [
    (pkgs.makeDesktopItem {
      name = "t3-code";
      desktopName = "T3 Code";
      exec = "t3-code %U";
      icon = "t3-code";
      startupWMClass = "t3-code";
      categories = [ "Development" "Utility" ];
      terminal = false;
    })
  ];

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    cp -a ${nodeModules}/node_modules ./node_modules

    for workspace_dir in apps/server packages/shared scripts; do
      if [ -d ${nodeModules}/"$workspace_dir"/node_modules ]; then
        mkdir -p "$workspace_dir"
        cp -a ${nodeModules}/"$workspace_dir"/node_modules "$workspace_dir/node_modules"
      fi
    done

    chmod -R u+w ./node_modules
    for workspace_dir in apps/server packages/shared scripts; do
      if [ -d "$workspace_dir/node_modules" ]; then
        chmod -R u+w "$workspace_dir/node_modules"
      fi
    done

    patchShebangs node_modules
    npm rebuild node-pty --build-from-source
    bun run --cwd apps/web build
    bun run build:desktop
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    appRoot="$out/libexec/t3code"
    mkdir -p "$appRoot/apps/desktop" "$appRoot/apps/server" "$appRoot/apps" "$out/bin"

    cp -a node_modules "$appRoot/node_modules"
    cp -a scripts "$appRoot/scripts"
    cp -a packages "$appRoot/packages"
    cp -a apps/desktop/dist-electron "$appRoot/apps/desktop/dist-electron"
    cp -a apps/desktop/resources "$appRoot/apps/desktop/resources"
    cp -a apps/web "$appRoot/apps/web"
    cp -a apps/marketing "$appRoot/apps/marketing"
    cp -a apps/server/. "$appRoot/apps/server"

    cat > "$appRoot/package.json" <<EOF
    {
      "name": "t3-code",
      "version": "${finalAttrs.version}",
      "main": "apps/desktop/dist-electron/main.js"
    }
    EOF

    rm -rf "$appRoot/node_modules/electron"
    rm -f "$appRoot/node_modules/.bin/electron"

    install -Dm644 apps/desktop/resources/icon.png \
      "$out/share/icons/hicolor/1024x1024/apps/t3-code.png"

    makeWrapper ${electronPackage}/bin/electron "$out/bin/t3-code" \
      --add-flags "$appRoot" \
      --unset ELECTRON_RUN_AS_NODE \
      --set-default T3CODE_NODE_EXECUTABLE ${pkgs.nodejs_24}/bin/node \
      --set-default T3CODE_DESKTOP_PACKAGE_CHANNEL nix \
      --set-default T3CODE_DISABLE_AUTO_UPDATE 1

    runHook postInstall
  '';

  meta = {
    description = "T3 Code desktop app packaged from source";
    homepage = "https://github.com/Anoromi/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3-code";
    platforms = lib.platforms.linux;
  };
})
