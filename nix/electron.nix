{
  coreutils,
  electron_41,
  lib,
  runCommand,
  util-linux,
  xdg-utils,
}:

runCommand "t3code-electron-${electron_41.version}"
  {
    meta.mainProgram = "t3code-electron";
  }
  ''
    mkdir -p "$out/bin"
    cp ${lib.getExe electron_41} "$out/bin/t3code-electron"

    # Desktop integration remains a runtime dependency when the captured user
    # PATH comes from a minimal Home Manager environment.
    sed -i '2i\
    export PATH=${lib.makeBinPath [ xdg-utils ]}:"\''${PATH:-}"' \
      "$out/bin/t3code-electron"

    # Nixpkgs points Electron at an immutable, non-setuid sandbox helper.
    # Replace it with the best sandbox strategy available on the host.
    sed -i '/^export CHROME_DEVEL_SANDBOX=/c\
    source ${./electron-sandbox.sh} ${lib.getExe' util-linux "unshare"} /run/wrappers/bin/chrome-sandbox ${lib.getExe' coreutils "stat"}' \
      "$out/bin/t3code-electron"
    sed -i 's#^exec \(.*\)  "\$@" *$#exec \1 "\''${sandbox_args[@]}" "\$@"#' \
      "$out/bin/t3code-electron"
    chmod +x "$out/bin/t3code-electron"
  ''
