# Desktop bind Corkdiff in-flight refresh ownership

Serialize automatic credential refreshes with connection adoption and bind each refresh to its ownership generation. A delayed refresh from an older backend now stops after newer credentials are installed instead of overwriting the live Neovim connection.

## Review Follow-up

This follow-up resolves the final pinned-base review finding for `desktop integrate Hyprnav and Corkdiff`. The regression test delays an old ticket resolution until a newer connection is installed, then verifies that the stale ticket is never sent to Neovim.
