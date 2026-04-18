{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.t3code;
  system = pkgs.stdenv.hostPlatform.system;
  defaultDesktopPackage = self.packages.${system}.desktop;

  localWrapper = pkgs.writeShellScriptBin cfg.local.commandName ''
    set -euo pipefail

    config_file=${lib.escapeShellArg cfg.local.configFile}
    jq_bin=${lib.escapeShellArg (lib.getExe pkgs.jq)}
    nix_bin=${lib.escapeShellArg (lib.getExe pkgs.nix)}

    if [ ! -f "$config_file" ]; then
      printf '%s: no local config found at %s\n' "${cfg.local.commandName}" "$config_file" >&2
      printf 'Run %s from a T3 Code checkout to configure it.\n' "${cfg.local.switchCommandName}" >&2
      exit 1
    fi

    if ! enabled="$("$jq_bin" -er '.enabled' "$config_file")"; then
      printf '%s: invalid local config in %s (expected boolean .enabled)\n' "${cfg.local.commandName}" "$config_file" >&2
      exit 1
    fi

    if [ "$enabled" != "true" ]; then
      printf '%s: local launcher is disabled in %s\n' "${cfg.local.commandName}" "$config_file" >&2
      exit 1
    fi

    if ! repo_root="$("$jq_bin" -er '.repoPath' "$config_file")"; then
      printf '%s: invalid local config in %s (expected string .repoPath)\n' "${cfg.local.commandName}" "$config_file" >&2
      exit 1
    fi

    case "$repo_root" in
      /*) ;;
      *)
        printf '%s: repoPath must be an absolute path in %s\n' "${cfg.local.commandName}" "$config_file" >&2
        exit 1
        ;;
    esac

    if [ ! -f "$repo_root/flake.nix" ]; then
      printf '%s: expected a flake at %s\n' "${cfg.local.commandName}" "$repo_root" >&2
      exit 1
    fi

    exec "$nix_bin" develop --impure "$repo_root" \
      --command bash "$repo_root/scripts/run-local-desktop.sh" "$repo_root" "$@"
  '';

  localPackage =
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
    '';

  switchPackage =
    pkgs.writeShellScriptBin cfg.local.switchCommandName ''
      set -euo pipefail

      repo_root="$(pwd -P)"
      config_dir=${lib.escapeShellArg (builtins.dirOf cfg.local.configFile)}
      config_file=${lib.escapeShellArg cfg.local.configFile}

      if [ ! -f "$repo_root/flake.nix" ]; then
        printf '%s: expected flake.nix in %s\n' "${cfg.local.switchCommandName}" "$repo_root" >&2
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

      printf '%s: configured %s to use %s\n' "${cfg.local.switchCommandName}" "${cfg.local.commandName}" "$repo_root"
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
    home.packages = [ cfg.package switchPackage localPackage ];
  };
}
