# Preserve Mobile Keybinding Compatibility

## Goal

Keep older native mobile clients compatible with the server keybinding contract without reducing the web or desktop catalog.

## Provenance

- Reimplements source commit `f3f69bd944`.
- Uses the client device metadata already persisted by upstream authentication sessions.

## Included scenarios

- Filters unsupported commands from bearer- and DPoP-authenticated native mobile responses.
- Preserves the complete catalog for desktop, unknown, and browser-cookie sessions.
- Projects compatibility consistently through initial config, mutations, snapshots, and live updates.
- Leaves the stored server keybinding catalog unchanged.

## Validation

- Focused compatibility unit tests.
- Mobile WebSocket publication integration test.
- Server lint and typecheck gates.
