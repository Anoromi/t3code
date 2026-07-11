# Restore Hyprnav settings and shortcut contracts

Carry project Hyprnav overrides through orchestration commands, events, projections, and snapshots; restore client-side Hyprnav defaults and grouped settings; and assign navigation to Mod+E while moving the command palette to Mod+K.

The startup keybinding repair only rewrites the exact previously generated default file, preserving genuinely customized configurations.

The navigation shortcut opens a scoped thread/project command menu; project results reopen an existing draft or start a new thread.
While the menu is open, global application shortcuts are suspended so modal keyboard input cannot trigger background actions.
