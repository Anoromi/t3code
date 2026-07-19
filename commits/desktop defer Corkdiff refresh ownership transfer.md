# Desktop defer Corkdiff refresh ownership transfer

Transfer credential-refresh ownership only after connection adoption and focus both succeed. If focus fails after Neovim accepts a replacement ticket, restore installed-generation bookkeeping so the prior refresh loop can restore and renew its connection.

## Review Follow-up

This follow-up resolves the per-commit review finding on `desktop bind Corkdiff in-flight refresh ownership`. Its regression keeps a live viewer's prior refresh ownership after replacement focus fails.
