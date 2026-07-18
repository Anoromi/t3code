# Preserve Local Desktop Launch Environment

## Goal

Keep the developer shell environment available when launching the Electron desktop application through Nix wrappers.

## Included Changes

- Captures and restores the local launch environment.
- Updates desktop startup wrappers and smoke coverage.
- Covers environment propagation and terminal startup behavior.
