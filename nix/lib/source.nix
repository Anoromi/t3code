{ lib, src }:

lib.cleanSourceWith {
  inherit src;
  filter =
    path: type:
    let
      relativePath = lib.removePrefix "${toString src}/" (toString path);
      baseName = builtins.baseNameOf (toString path);
      ignoredDirectories = [
        ".git"
        ".direnv"
        ".turbo"
        "node_modules"
        "dist"
        "dist-electron"
        "result"
      ];
      ignoredSuffixes = [
        ".tsbuildinfo"
        ".log"
      ];
      isIgnoredDirectory = type == "directory" && lib.elem baseName ignoredDirectories;
      isIgnoredFile =
        lib.any (suffix: lib.hasSuffix suffix relativePath) ignoredSuffixes
        || baseName == "flake.lock";
    in
    !(isIgnoredDirectory || isIgnoredFile);
}
