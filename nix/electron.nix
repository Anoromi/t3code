{
  electron_41,
  lib,
  runCommand,
}:

runCommand "t3code-electron-${electron_41.version}"
  {
    meta.mainProgram = "t3code-electron";
  }
  ''
    mkdir -p "$out/bin"
    cp ${lib.getExe electron_41} "$out/bin/t3code-electron"
    chmod +x "$out/bin/t3code-electron"
  ''
