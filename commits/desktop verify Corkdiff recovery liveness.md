# Desktop: verify Corkdiff recovery liveness

## Goal

Make stale-window and failed-refresh liveness checks conservative under duplicate clients and secondary inspection failures.

## Included Changes

- Inspects every valid same-class Hyprland client before declaring a specific stale address closed.
- Marks the current session unhealthy before querying post-failure window liveness.
- Preserves the primary Neovim failure if the secondary Hyprland inspection also fails.

## Validation Coverage

Preserve focused duplicate-client ordering, target-address closure, rejected liveness inspection, primary error preservation, and unhealthy-session recovery scenarios.

## Review Provenance

Resolves both findings from `codex review --commit 2659b18c16`.
