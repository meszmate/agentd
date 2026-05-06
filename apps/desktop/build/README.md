# build/

electron-builder reads platform icons and other resources from this directory:

- `icon.icns` — macOS app icon (1024x1024 source recommended)
- `icon.ico` — Windows app icon
- `icon.png` — Linux app icon (512x512+)
- `background.png` — DMG background (optional)

Drop the platform icons here when there's a real brand asset. Until then,
electron-builder falls back to its default placeholder icon, which is fine
for local builds and dev installers.
