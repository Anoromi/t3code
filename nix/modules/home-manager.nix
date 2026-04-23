{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.t3code;
  system = pkgs.stdenv.hostPlatform.system;
  defaultDesktopPackage = self.packages.${system}.desktop;
  xdgConfigHome =
    if config ? xdg && config.xdg ? configHome then
      config.xdg.configHome
    else
      "${config.home.homeDirectory}/.config";
  localConfigPointerFile = "${xdgConfigHome}/t3code/local-config-path";
  localConfigPathHelpers = ''
    default_config_file=${lib.escapeShellArg cfg.local.configFile}
    local_config_pointer_file=${lib.escapeShellArg localConfigPointerFile}

    config_file_from_home_manager_dir() {
      printf '%s/.local/t3-local.json\n' "''${1%/}"
    }

    config_file_from_config_dir() {
      printf '%s/t3-local.json\n' "''${1%/}"
    }

    resolve_config_file() {
      if [ -n "''${T3CODE_LOCAL_CONFIG_FILE:-}" ]; then
        printf '%s\n' "$T3CODE_LOCAL_CONFIG_FILE"
        return
      fi
      if [ -n "''${T3CODE_HOME_MANAGER_DIR:-}" ]; then
        config_file_from_home_manager_dir "$T3CODE_HOME_MANAGER_DIR"
        return
      fi
      if [ -n "''${T3CODE_LOCAL_CONFIG_DIR:-}" ]; then
        config_file_from_config_dir "$T3CODE_LOCAL_CONFIG_DIR"
        return
      fi
      if [ -f "$local_config_pointer_file" ]; then
        read -r remembered_config_file < "$local_config_pointer_file" || remembered_config_file=
        if [ -n "$remembered_config_file" ]; then
          printf '%s\n' "$remembered_config_file"
          return
        fi
      fi
      printf '%s\n' "$default_config_file"
    }

    remember_config_file() {
      pointer_dir="$(dirname "$local_config_pointer_file")"
      mkdir -p "$pointer_dir"
      pointer_tmp_file="$(mktemp "$pointer_dir/local-config-path.tmp.XXXXXX")"
      printf '%s\n' "$1" > "$pointer_tmp_file"
      mv "$pointer_tmp_file" "$local_config_pointer_file"
    }
  '';

  localWrapper = pkgs.writeShellScriptBin cfg.local.commandName ''
    set -euo pipefail

    jq_bin=${lib.escapeShellArg (lib.getExe pkgs.jq)}
    nix_bin=${lib.escapeShellArg (lib.getExe pkgs.nix)}
    bash_bin=${lib.escapeShellArg (lib.getExe pkgs.bashInteractive)}
    ${localConfigPathHelpers}
    config_file="$(resolve_config_file)"

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

    launch_env_file="$(mktemp "''${XDG_RUNTIME_DIR:-/tmp}/t3code-local-env.XXXXXX")"
    env -0 > "$launch_env_file"
    export T3CODE_LOCAL_LAUNCH_ENV_FILE="$launch_env_file"

    exec "$nix_bin" develop --impure "$repo_root" \
      --command "$bash_bin" "$repo_root/scripts/run-local-desktop.sh" "$repo_root" "$@"
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
      jq_bin=${lib.escapeShellArg (lib.getExe pkgs.jq)}
      ${localConfigPathHelpers}
      config_file=
      remember_custom_config=false
      allow_remember=true

      usage() {
        cat <<EOF
      Usage: ${cfg.local.switchCommandName} [--home-manager-dir DIR | --config-file FILE] [--no-remember]

      Configures ${cfg.local.commandName} to launch the T3 Code checkout in the current directory.

      Options:
        --home-manager-dir DIR  Write DIR/.local/t3-local.json.
        --config-file FILE      Write an exact local launcher JSON path.
        --no-remember          Do not remember a custom path for ${cfg.local.commandName}.
        -h, --help             Show this help.

      Environment:
        T3CODE_HOME_MANAGER_DIR  Same as --home-manager-dir.
        T3CODE_LOCAL_CONFIG_DIR  Writes DIR/t3-local.json.
        T3CODE_LOCAL_CONFIG_FILE Writes an exact local launcher JSON path.
      EOF
      }

      while [ "$#" -gt 0 ]; do
        case "$1" in
          --home-manager-dir)
            if [ "$#" -lt 2 ]; then
              printf '%s: --home-manager-dir requires a directory\n' "${cfg.local.switchCommandName}" >&2
              exit 1
            fi
            config_file="$(config_file_from_home_manager_dir "$2")"
            remember_custom_config=true
            shift 2
            ;;
          --config-file)
            if [ "$#" -lt 2 ]; then
              printf '%s: --config-file requires a file path\n' "${cfg.local.switchCommandName}" >&2
              exit 1
            fi
            config_file="$2"
            remember_custom_config=true
            shift 2
            ;;
          --no-remember)
            allow_remember=false
            shift
            ;;
          -h|--help)
            usage
            exit 0
            ;;
          --)
            shift
            break
            ;;
          *)
            printf '%s: unexpected argument: %s\n' "${cfg.local.switchCommandName}" "$1" >&2
            usage >&2
            exit 1
            ;;
        esac
      done

      if [ "$#" -gt 0 ]; then
        printf '%s: unexpected argument: %s\n' "${cfg.local.switchCommandName}" "$1" >&2
        usage >&2
        exit 1
      fi

      if [ -z "$config_file" ]; then
        config_file="$(resolve_config_file)"
        if [ -n "''${T3CODE_LOCAL_CONFIG_FILE:-}" ] ||
          [ -n "''${T3CODE_HOME_MANAGER_DIR:-}" ] ||
          [ -n "''${T3CODE_LOCAL_CONFIG_DIR:-}" ]; then
          remember_custom_config=true
        fi
      fi

      case "$config_file" in
        /*) ;;
        *)
          printf '%s: config file must be an absolute path: %s\n' "${cfg.local.switchCommandName}" "$config_file" >&2
          exit 1
          ;;
      esac

      config_dir="$(dirname "$config_file")"

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
        existing_parent_dir="$config_dir"
        while [ ! -e "$existing_parent_dir" ]; do
          next_parent_dir="$(dirname "$existing_parent_dir")"
          if [ "$next_parent_dir" = "$existing_parent_dir" ]; then
            break
          fi
          existing_parent_dir="$next_parent_dir"
        done
        if [ ! -d "$existing_parent_dir" ]; then
          printf '%s: cannot create %s because %s is not a directory\n' "${cfg.local.switchCommandName}" "$config_dir" "$existing_parent_dir" >&2
          exit 1
        fi
        if [ ! -w "$existing_parent_dir" ]; then
          printf '%s: cannot create %s because %s is not writable\n' "${cfg.local.switchCommandName}" "$config_dir" "$existing_parent_dir" >&2
          exit 1
        fi
      fi

      mkdir -p "$config_dir"
      tmp_file="$(mktemp "$config_dir/t3-local.json.tmp.XXXXXX")"
      trap 'rm -f "$tmp_file"' EXIT
      "$jq_bin" -n --arg repoPath "$repo_root" '{ enabled: true, repoPath: $repoPath }' > "$tmp_file"
      mv "$tmp_file" "$config_file"
      trap - EXIT

      if [ "$remember_custom_config" = "true" ] && [ "$allow_remember" = "true" ]; then
        remember_config_file "$config_file"
      fi

      printf '%s: configured %s to use %s via %s\n' "${cfg.local.switchCommandName}" "${cfg.local.commandName}" "$repo_root" "$config_file"
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
      default = "${xdgConfigHome}/t3code/t3-local.json";
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
