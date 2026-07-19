# Desktop capture Corkdiff adoption rollback state

Capture connection-generation rollback state only after earlier queued adoptions have settled. A later adoption that installs credentials but fails to focus now restores the immediately preceding successful generation instead of an older snapshot.

## Review Follow-up

This follow-up resolves the queued-adoption finding on `desktop defer Corkdiff refresh ownership transfer`. Its regression serializes three generations, delays the middle update, fails the final focus, and verifies ownership and installed-generation bookkeeping remain on the middle connection.
