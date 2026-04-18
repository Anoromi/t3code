# web: add worktree navigation and terminal UI

## Goal

Preserve the branch's worktree-centered web experience on top of upstream's current React routes, state stores, and keyboard handling.

## Implementation Summary

- Adds worktree-aware sidebar grouping, navigation command menu state, thread recency sorting, and branch/worktree controls.
- Reworks the terminal drawer around shared terminal viewport code with Xterm and Ghostty-backed renderers.
- Adds renderer state for terminal sessions, worktree terminal presence, external Corkdiff resolution, and terminal event fanout.
- Carries forward global shortcut handling, held-navigation performance fixes, and terminal-focus bypass behavior.
- Updates routes, chat view wiring, composer controls, toasts, settings, and thread actions to use the rebased worktree and terminal primitives.

## Reimplementation Notes

- Keep sidebar and command menu behavior data-driven through logic modules so heavy rendering work stays out of keyboard repeat paths.
- Preserve the external desktop Corkdiff path while keeping the embedded web diff viewer available outside Electron.
- Use the server and desktop contracts introduced by the lower commits instead of recreating renderer-only terminal state.

## Expected Behavior

- Worktree groups, branch selectors, and command-menu navigation remain responsive under held-key navigation.
- The terminal drawer can render shell output, preserve session state, and interoperate with worktree terminal launches.
- Chat, settings, and route transitions keep using the same environment/thread data while exposing the new worktree UI.
