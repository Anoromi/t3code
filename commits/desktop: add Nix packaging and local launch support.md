# desktop: add Nix packaging and local launch support

Current hash: `pending` (informational; may change after rebase/amend)
Date: `2026-04-18`

## A. What This Achieves

Adds Nix packaging, Home Manager integration, and local desktop launch helpers while keeping desktop development startup explicit and reproducible.

## B. How It Achieves It

The commit adds the flake, Nix package/module helpers, Bun dependency source support, desktop artifact build support, local run scripts, Electron runtime argument helpers, and dev-runner state isolation used by desktop launches.

## C. Reimplementation Notes

Keep packaged runtime behavior separate from development launch behavior. Nix-managed builds should not depend on mutable local state, and externally managed desktop installs should avoid normal auto-update assumptions.

## D. Expected Behavioral Results

- The repository exposes Nix outputs for building and installing the desktop app.
- The Home Manager module can install from packaged or local sources.
- Desktop dev launch scripts resolve Electron/runtime arguments predictably and isolate local state per worktree.
