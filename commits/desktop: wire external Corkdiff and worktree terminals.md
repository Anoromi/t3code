# desktop: wire external Corkdiff and worktree terminals

## Goal

Preserve the desktop-only terminal integration from the branch while rebasing it onto upstream Electron startup and IPC code.

## Implementation Summary

- Replaces the obsolete embedded desktop startup readiness helper with a desktop daemon readiness flow.
- Adds Electron main-process ownership for external Corkdiff sessions and Ghostty worktree terminal sessions.
- Wires preload IPC methods for renderer requests to open, focus, list, and manage desktop-owned sessions.
- Adds shared desktop daemon schemas and terminal contract coverage used by the desktop IPC boundary.
- Keeps shell environment synchronization compatible with local Wayland/Hyprland launches.

## Reimplementation Notes

- Desktop Corkdiff remains external and Ghostty-backed; the renderer should not own the old embedded Corkdiff terminal lifecycle.
- Session ownership stays in Electron main so focus/open behavior is deterministic across renderer reloads.
- Keep the desktop daemon protocol schema-based so server and renderer callers do not depend on ad hoc IPC payloads.

## Expected Behavior

- `Ctrl+D` can open or focus the active thread's external Corkdiff session in desktop.
- Worktree terminals launch through the desktop Ghostty path and can be listed or focused from the app.
- Desktop startup waits on the daemon/readiness path without regressing web or server startup.
