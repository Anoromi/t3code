{
  electron_41,
  lib,
  runCommand,
  util-linux,
}:

runCommand "t3code-electron-${electron_41.version}"
  {
    meta.mainProgram = "t3code-electron";
  }
  ''
    mkdir -p "$out/bin"
    cp ${lib.getExe electron_41} "$out/bin/t3code-electron"

    # Nixpkgs points Electron at an immutable, non-setuid sandbox helper.
    # Prefer the NixOS-managed setuid wrapper when present; otherwise leave
    # Chromium to use its user-namespace sandbox.
    sed -i '/^export CHROME_DEVEL_SANDBOX=/c\
    sandbox_args=()\
    if [[ -x /run/wrappers/bin/chrome-sandbox ]]; then\
      export CHROME_DEVEL_SANDBOX=/run/wrappers/bin/chrome-sandbox\
    elif ${lib.getExe' util-linux "unshare"} -Ur true 2>/dev/null; then\
      unset CHROME_DEVEL_SANDBOX\
      sandbox_args+=(--disable-setuid-sandbox)\
    else\
      unset CHROME_DEVEL_SANDBOX\
      sandbox_args+=(--no-sandbox)\
    fi' "$out/bin/t3code-electron"
    sed -i 's#^exec \(.*\)  "\$@" *$#exec \1 "\''${sandbox_args[@]}" "\$@"#' \
      "$out/bin/t3code-electron"
    chmod +x "$out/bin/t3code-electron"
  ''
