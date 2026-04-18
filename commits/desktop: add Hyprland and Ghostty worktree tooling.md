# desktop: add Hyprland and Ghostty worktree tooling

## Goal

Add reusable desktop-side helpers for launching worktree terminals on Hyprland through Ghostty without coupling the behavior to Electron IPC.

## Implementation Summary

- Adds tested `ghostty-worktree` and `hypr-worktree` scripts for workspace selection, process launch, and fallback handling.
- Adds shared worktree path helpers used by the launch scripts.
- Adds a desktop Hypr workspace helper with tests for workspace lookup and launcher behavior.

## Reimplementation Notes

- Keep this as the standalone launch-tooling layer on top of upstream/main.
- Later desktop commits should wire Electron and renderer shortcuts into these helpers instead of duplicating Hyprland or Ghostty process logic.

## Expected Behavior

- Worktree terminal launch helpers can be tested independently.
- Hyprland workspace targeting and Ghostty command construction stay deterministic under failure paths.
