# web: improve read-aloud interaction

## Goal

Add and refine thread read-aloud behavior across server audio generation, web playback, and user-facing controls.

## Included Changes

- Adds thread read-aloud controls, pause/resume, stop, skip, voice, and WPM settings.
- Integrates local audio generation, caching, playback orchestration, and warmup behavior.
- Adds highlighting, viewport tracking, code-block focus behavior, and prose segmentation.
- Adds text normalization, silent-unit handling, and audio playback tests.

## Expected Behavior

Users can read thread and plan markdown aloud from selected prose while the interface tracks the active spoken content and keeps playback controls responsive.
