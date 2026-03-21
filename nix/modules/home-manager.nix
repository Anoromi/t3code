{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.t3code;
  system = pkgs.stdenv.hostPlatform.system;
  defaultDesktopPackage = self.packages.${system}.desktop;
  localConfigPath = cfg.local.configFile;
  hasLocalConfig = builtins.pathExists localConfigPath;
  parsedLocalConfig =
    if hasLocalConfig then
      builtins.tryEval (builtins.fromJSON (builtins.readFile localConfigPath))
    else
      {
        success = true;
        value = null;
      };
  localConfig =
    if hasLocalConfig && parsedLocalConfig.success then parsedLocalConfig.value else null;
  localConfigIsAttrs = localConfig != null && builtins.isAttrs localConfig;
  localEnabledValue =
    if localConfigIsAttrs && localConfig ? enabled then localConfig.enabled else false;
  localRepoPathValue =
    if localConfigIsAttrs && localConfig ? repoPath then localConfig.repoPath else null;
  localRepoPathIsAbsolute =
    builtins.isString localRepoPathValue && lib.hasPrefix "/" localRepoPathValue;
  localRepoFlakePath =
    if localRepoPathIsAbsolute then "${localRepoPathValue}/flake.nix" else null;
  localRepoHasFlake =
    localRepoFlakePath != null && builtins.pathExists localRepoFlakePath;
  localEnabled = localEnabledValue == true && localRepoPathIsAbsolute && localRepoHasFlake;

  localWrapper =
    if localEnabled then
      pkgs.writeShellScriptBin cfg.local.commandName ''
        set -euo pipefail
        repo_root=${lib.escapeShellArg localRepoPathValue}
        if [ ! -f "$repo_root/flake.nix" ]; then
          printf '${cfg.local.commandName}: expected a flake at %s\n' "$repo_root" >&2
          exit 1
        fi

        desktop_path="$(${lib.getExe pkgs.nix} build --no-link --print-out-paths ${lib.escapeShellArg "${localRepoPathValue}#desktop"})"
        exec "$desktop_path/bin/t3-code" "$@"
      ''
    else
      null;

  localPackage =
    if localEnabled then
      pkgs.runCommand "t3code-local-launcher" { } ''
        mkdir -p "$out/bin" "$out/share/applications"

        ln -s ${localWrapper}/bin/${cfg.local.commandName} "$out/bin/${cfg.local.commandName}"

        printf '%s\n' \
          '[Desktop Entry]' \
          'Type=Application' \
          'Version=1.0' \
          'Name=${cfg.local.desktopName}' \
          'Exec=${cfg.local.commandName} %U' \
          'Icon=${cfg.local.iconName}' \
          'Categories=Development;Utility;' \
          'StartupWMClass=t3-code' \
          'Terminal=false' \
          > "$out/share/applications/${cfg.local.commandName}.desktop"
      ''
    else
      null;

  switchPackage =
    pkgs.writeShellScriptBin cfg.local.switchCommandName ''
      set -euo pipefail

      repo_root="$(pwd -P)"
      nixos_root="/etc/nixos"
      config_dir=${lib.escapeShellArg (builtins.dirOf cfg.local.configFile)}
      config_file=${lib.escapeShellArg cfg.local.configFile}
      hm_flake=${lib.escapeShellArg cfg.local.homeManagerFlake}
      home_manager=${lib.escapeShellArg (lib.getExe pkgs.home-manager)}
      nix_bin=${lib.escapeShellArg (lib.getExe pkgs.nix)}

      if [ ! -x "$home_manager" ]; then
        printf '%s: home-manager executable not found at %s\n' "${cfg.local.switchCommandName}" "$home_manager" >&2
        exit 1
      fi

      if [ ! -x "$nix_bin" ]; then
        printf '%s: nix executable not found at %s\n' "${cfg.local.switchCommandName}" "$nix_bin" >&2
        exit 1
      fi

      if [ ! -f "$repo_root/flake.nix" ]; then
        printf '%s: expected flake.nix in %s\n' "${cfg.local.switchCommandName}" "$repo_root" >&2
        exit 1
      fi

      if [ ! -d "$nixos_root" ]; then
        printf '%s: expected %s to exist\n' "${cfg.local.switchCommandName}" "$nixos_root" >&2
        exit 1
      fi

      if [ ! -w "$nixos_root" ]; then
        printf '%s: cannot write to %s\n' "${cfg.local.switchCommandName}" "$nixos_root" >&2
        exit 1
      fi

      if [ -e "$config_dir" ]; then
        if [ ! -d "$config_dir" ]; then
          printf '%s: expected %s to be a directory\n' "${cfg.local.switchCommandName}" "$config_dir" >&2
          exit 1
        fi
        if [ ! -w "$config_dir" ]; then
          printf '%s: cannot write to %s\n' "${cfg.local.switchCommandName}" "$config_dir" >&2
          exit 1
        fi
      else
        parent_dir="$(dirname "$config_dir")"
        if [ ! -w "$parent_dir" ]; then
          printf '%s: cannot create %s because %s is not writable\n' "${cfg.local.switchCommandName}" "$config_dir" "$parent_dir" >&2
          exit 1
        fi
      fi

      mkdir -p "$config_dir"
      tmp_file="$(mktemp "$config_dir/t3-local.json.tmp.XXXXXX")"
      trap 'rm -f "$tmp_file"' EXIT
      cat > "$tmp_file" <<EOF
      {
        "enabled": true,
        "repoPath": "$repo_root"
      }
      EOF
      mv "$tmp_file" "$config_file"
      trap - EXIT

      "$nix_bin" flake lock --update-input t3code "$nixos_root"
      exec "$home_manager" switch --impure --flake "$hm_flake"
    '';
in
{
  options.programs.t3code = {
    enable = lib.mkEnableOption "T3 Code desktop app";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultDesktopPackage;
      description = "The T3 Code desktop package to install.";
    };

    local.configFile = lib.mkOption {
      type = lib.types.str;
      default = "/etc/nixos/.local/t3-local.json";
      description = "JSON file that controls the local T3 Code launcher.";
    };

    local.commandName = lib.mkOption {
      type = lib.types.str;
      default = "t3code-local";
      description = "Command name for the local T3 Code launcher.";
    };

    local.switchCommandName = lib.mkOption {
      type = lib.types.str;
      default = "t3code-switch";
      description = "Command name used to switch the local T3 Code source.";
    };

    local.homeManagerFlake = lib.mkOption {
      type = lib.types.str;
      default = "/etc/nixos#anoromi";
      description = "Home Manager flake target used by the switch command.";
    };

    local.desktopName = lib.mkOption {
      type = lib.types.str;
      default = "T3 Code Local";
      description = "Desktop entry name for the local T3 Code launcher.";
    };

    local.iconName = lib.mkOption {
      type = lib.types.str;
      default = "t3-code";
      description = "Existing icon name for the local T3 Code launcher.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !hasLocalConfig || parsedLocalConfig.success;
        message = "programs.t3code.local.configFile contains invalid JSON: ${localConfigPath}";
      }
      {
        assertion = !hasLocalConfig || localConfigIsAttrs;
        message = "programs.t3code.local.configFile must contain a JSON object: ${localConfigPath}";
      }
      {
        assertion = !hasLocalConfig || !localConfigIsAttrs || !localConfig ? enabled || builtins.isBool localConfig.enabled;
        message = "programs.t3code.local.configFile must set \"enabled\" to a boolean when present: ${localConfigPath}";
      }
      {
        assertion = !hasLocalConfig || localEnabledValue != true || localConfig ? repoPath;
        message = "programs.t3code.local.configFile must set \"repoPath\" when \"enabled\" is true: ${localConfigPath}";
      }
      {
        assertion = !hasLocalConfig || localEnabledValue != true || builtins.isString localRepoPathValue;
        message = "programs.t3code.local.configFile must set \"repoPath\" to a string when \"enabled\" is true: ${localConfigPath}";
      }
      {
        assertion = !hasLocalConfig || localEnabledValue != true || localRepoPathIsAbsolute;
        message = "programs.t3code.local.configFile must set \"repoPath\" to an absolute path when \"enabled\" is true: ${localConfigPath}";
      }
      {
        assertion = !hasLocalConfig || localEnabledValue != true || localRepoHasFlake;
        message = "programs.t3code.local.configFile repoPath must contain flake.nix when \"enabled\" is true: ${localConfigPath}";
      }
    ];

    home.packages =
      [ cfg.package switchPackage ]
      ++ lib.optional localEnabled localPackage;
  };
}
