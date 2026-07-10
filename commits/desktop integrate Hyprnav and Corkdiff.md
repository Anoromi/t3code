# Desktop: integrate Hyprnav and Corkdiff

Desktop `Ctrl+D` now opens or focuses one external Corkdiff Ghostty workspace per primary-local thread through `hyprnav spawn --print-workspace-id rand -- ghostty ...`. Browser and remote-environment threads retain the in-app diff viewer.

Electron main owns session discovery and launch coalescing. It waits for the uniquely classed Ghostty client before reporting success, recovers existing windows after an Electron restart, and uses direct argv/environment passing with bounded commands.

Corkdiff returns focus through the action-only `desktop.requestCorkdiffAppFocus` RPC. The server performs a bounded Hyprland client lookup and focuses the desktop window directly; no renderer subscription or event stream is added.

The command palette shortcut moves from `Ctrl/Cmd+K` to `Ctrl/Cmd+E`, including preview-webview forwarding and documentation.
