{ pkgs, src, bunConfig }:

pkgs.stdenv.mkDerivation {
  pname = "t3code-node-modules";
  version = bunConfig.version;
  inherit src;

  nativeBuildInputs = with pkgs; [
    bun
    git
    nodejs_24
    pkg-config
    python3
  ];

  env = {
    npm_config_nodedir = pkgs.nodejs_24;
  };

  outputHashMode = "recursive";
  outputHashAlgo = "sha256";
  outputHash = bunConfig.hash;
  dontFixup = true;
  dontPatchShebangs = true;
  dontStrip = true;

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    bun install --frozen-lockfile --linker=hoisted --ignore-scripts

    top_level_effect="node_modules/effect"
    if [ -d "$top_level_effect" ]; then
      while IFS= read -r nested_effect; do
        [ "$nested_effect" = "$top_level_effect" ] && continue
        rm -rf "$nested_effect"
        ln -s "$(realpath --relative-to="$(dirname "$nested_effect")" "$top_level_effect")" "$nested_effect"
      done < <(find node_modules -path '*/node_modules/effect' -type d | sort)

      for workspace_dir in apps/server packages/shared scripts; do
        mkdir -p "$workspace_dir/node_modules"
        ln -sfn \
          "$(realpath --relative-to="$workspace_dir/node_modules" "$top_level_effect")" \
          "$workspace_dir/node_modules/effect"
      done
    fi
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"

    cp -a node_modules "$out/node_modules"

    for workspace_dir in apps/server packages/shared scripts; do
      if [ -d "$workspace_dir/node_modules" ]; then
        mkdir -p "$out/$workspace_dir"
        cp -a "$workspace_dir/node_modules" "$out/$workspace_dir/node_modules"
      fi
    done

    runHook postInstall
  '';
}
