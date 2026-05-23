# desktop: add Nix packaging and local launch support

## Goal

Add reproducible Nix packaging, Home Manager integration, and local desktop launch tooling for development and packaged desktop runs.

## Included Changes

- Adds flake outputs, desktop package wiring, Nix helper modules, and Bun/node-modules source handling.
- Derives Nix workspace dependency handling from package.json workspaces so new workspace packages do not require parallel hardcoded Nix list updates.
- Adds Home Manager support for packaged and local launcher installs, including configurable local launcher paths.
- Updates Bun and node-modules hashes used by the desktop package.
- Adds local desktop launch scripts and cached launcher behavior.
- Fixes shell/runtime argument handling for Electron development launches.
- Preserves launch environment values across desktop, Ghostty, Corkdiff, and terminal spawns.

## Expected Behavior

The desktop app can be built and installed through Nix or launched locally with predictable runtime arguments, stable dependency hashes, and preserved environment context.
