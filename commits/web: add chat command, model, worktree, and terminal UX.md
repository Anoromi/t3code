# web: add chat command, model, worktree, and terminal UX

## Goal

Add the worktree-centered chat experience, command surfaces, model-option propagation, and terminal UI behavior for the web app.

## Included Changes

- Adds `/worktree`, branch/worktree controls, worktree-aware navigation, and command menu behavior.
- Adds the thread command bar and chat-scoped focus/interrupt shortcuts.
- Restores global chat shortcuts for composer focus, thread interrupt, command palette, command menu, and worktree terminal actions.
- Dispatches thread-fork commands with canonical `forkSourceThreadId` naming.
- Requires slash prefixes for composer commands and preserves pending-input number shortcuts.
- Propagates `/fast`, reasoning, and model-option draft state into turn starts.
- Preserves Codex default traits and recovers no-active-session input prompts.
- Shows completed status in navigation and prioritizes command palette threads by user recency.
- Adds terminal drawer behavior, split/new/close controls, worktree context retention, and renderer terminal state.
- Groups sidebar sibling threads by worktree and carries worktree-group title state through navigation.
- Shows queued turn starts as working in sidebar status pills while the provider is still assigning a turn ID.
- Keeps stale awaiting-input failures recoverable and composer-visible when live data contains old Codex unknown-pending request errors.
- Submits recovered awaiting-input answers as a normal follow-up turn instead of retrying a dead provider callback.
- Stabilizes chat timeline and composer state, including plan override reset behavior.

## Expected Behavior

Users can drive worktree, model, command, and terminal workflows from the chat UI while preserving active thread context, keyboard behavior, sidebar worktree grouping, and stable composer/timeline state.
