{ lib, src }:

let
  packageJson = builtins.fromJSON (builtins.readFile (src + "/package.json"));
  workspacePatterns = packageJson.workspaces.packages or [ ];

  hasPackageJson = path: builtins.pathExists (src + "/${path}/package.json");

  expandPattern =
    pattern:
    if lib.hasSuffix "/*" pattern then
      let
        parent = lib.removeSuffix "/*" pattern;
        entries = builtins.readDir (src + "/${parent}");
      in
      builtins.filter hasPackageJson (
        builtins.map (name: "${parent}/${name}") (
          builtins.attrNames (
            lib.filterAttrs (_: type: type == "directory") entries
          )
        )
      )
    else if hasPackageJson pattern then
      [ pattern ]
    else
      [ ];
in
lib.unique (builtins.concatMap expandPattern workspacePatterns)
