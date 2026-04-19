# hyprnav: add project slot configuration

## Goal

Let projects define Hyprnav slot bindings that T3 Code can save, apply, and keep synchronized with the active desktop worktree.

## Implementation Summary

- Adds project Hyprnav settings to orchestration contracts, projection state, persistence, migration coverage, and command validation.
- Adds a project settings page for editing arbitrary Hyprnav slots with built-in actions or custom shell commands.
- Wires Electron IPC for applying project Hyprnav settings and locking/syncing the active worktree on thread switches.
- Stores Hyprnav launch commands with `slot command set` after assigning managed slots, so Hyprnav owns the workspace and command lifecycle.
- Uses a direct Ghostty/tmux launch command for the Worktree terminal action instead of nesting `hyprnav spawn`.

## Reimplementation Notes

- Desktop Corkdiff remains disabled for Hyprnav project slots; only Worktree terminal, Open favorite editor, and shell commands are exposed.
- Worktree terminal commands use Ghostty's config-argument form, `--working-directory=<path>`, to avoid Ghostty configuration errors.
- Active thread changes should sync the selected worktree asynchronously and leave future `hyprnav goto --slot <n>` calls fully managed by Hyprnav.

## Expected Behavior

- Saving project settings persists Hyprnav bindings and applies them through Electron when available.
- Switching desktop threads updates the locked Hyprnav environment and slot launch commands for that worktree.
- Repeated `hyprnav goto --slot <n>` calls land on the same managed workspace instead of spawning or redirecting through a random workspace.
