# web restore keyboard composer actions

## Goal

Restore keyboard-only branch, worktree, reasoning, and fast-mode composer actions on the current provider and VCS architecture.

## Included Changes

- Adds `/branch`, `/worktree`, `/reasoning`, and `/fast` composer actions without restoring the `/r` alias.
- Loads reasoning and fast-mode support from the selected model's live option descriptors.
- Keeps branch selection aligned with existing checkout and worktree behavior.
- Persists named worktree branch targets separately from their base refs.
- Adds focused unit and Chromium browser coverage driven entirely by keyboard input.

## Expected Behavior

Users can select available reasoning modes, toggle fast mode, switch or reuse branches and worktrees, and prepare named worktrees without using the mouse.
