# desktop: wire Hyprland, Hyprnav, Corkdiff, and worktree terminals

## Goal

Wire desktop-owned Hyprland, Hyprnav, external Corkdiff, and Ghostty worktree-terminal workflows into the app.

## Included Changes

- Adds tested Ghostty and Hyprland launch helpers for worktree terminals.
- Adds Electron main-process ownership for external Corkdiff and worktree terminal sessions.
- Adds desktop daemon records and a single-instance focus controller so secondary launches focus the primary desktop instance.
- Adds server-side desktop focus control for external Corkdiff return-to-app flows.
- Adds Hyprnav project slots, settings persistence, and desktop application wiring.
- Adds explicit workspace targeting and thread title/slot synchronization.
- Preserves custom Hyprnav defaults while sanitizing keybindings.
- Reduces desktop freeze risk during Hyprnav synchronization.
- Fixes first daemon launch window behavior and retries desktop auth bootstrap before issuing Corkdiff tokens.
- Repairs live database projection compatibility for provider-instance columns and legacy thread projection model columns.
- Adds tests for Hyprnav settings migrations, desktop launch helpers, Corkdiff ownership, desktop daemon control, worktree terminals, terminal output coalescing, and live-schema projection writes.

## Expected Behavior

Desktop users can move between active worktrees, focus external Corkdiff, launch worktree terminals, focus an existing desktop instance on repeat launch, and keep Hyprnav slots synchronized without renderer-owned process state or repeated desktop startup failures.
