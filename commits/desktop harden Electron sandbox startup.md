# Harden Electron Sandbox Startup

## Goal

Make packaged Electron startup reliable when the host sandbox helper cannot be used directly.

## Included Changes

- Adds a controlled Electron sandbox startup wrapper.
- Wires the wrapper into the Nix desktop package.
- Adds focused regression coverage for sandbox selection and launch arguments.
