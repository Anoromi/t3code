# desktop: add CJK font fallback support

## Goal

Make CJK text render with usable fallback fonts in the web UI and Nix-packaged desktop app.

## Included Changes

- Adds common CJK sans-serif fallbacks after Fast Sans in the app font stack.
- Configures the Nix desktop wrapper with a fontconfig file that exposes `noto-fonts-cjk-sans`.

## Expected Behavior

Japanese, Chinese, and Korean text can fall back to installed CJK fonts instead of rendering as missing glyph boxes in the desktop package.
