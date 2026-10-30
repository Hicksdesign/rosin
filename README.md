# Rosin

A personal macOS wrapper for the Qobuz web player, with custom CSS and fonts,
extra keyboard shortcuts and a menubar now-playing item.

## Getting started

```sh
brew install xcodegen
cd Rosin
xcodegen generate
open Rosin.xcodeproj
```

Set your signing team in the target's Signing & Capabilities tab, then run.

## Shortcuts

| Shortcut | Action |
|---|---|
| ⌘[ / ⌘] | Back / forward (two-finger swipe works too) |
| ⌘F | Search |
| Esc | Close the immersive view (passed on to the page otherwise) |
| ⌘→ / ⌘← | Next / previous track |
| ⌘⇧H | Home |
| ⌘R | Reload page (re-reads inject.js and custom.css) |
| ⌘⇧R | Re-apply custom CSS and fonts without reloading |

Change them in `Sources/MainMenu.swift`.

## Custom CSS

Edit `Resources/custom.css` and press ⌘⇧R. In Debug builds the file is read from
the project folder, so no rebuild is needed. For a Release build, drop a
`custom.css` into `~/Library/Application Support/Rosin/` to override the
bundled one.

## Custom fonts

1. Put the font files in `Resources/Fonts/` (woff2, otf or ttf).
2. List them in `Resources/Fonts/fonts.json`:

   ```json
   [
     { "family": "My Sans", "file": "MySans-Variable.woff2", "weight": "100 900", "style": "normal" },
     { "family": "My Sans", "file": "MySans-VariableItalic.woff2", "weight": "100 900", "style": "italic" }
   ]
   ```

3. Use `font-family: "My Sans"` in `custom.css`.

## Debugging

Safari ▸ Develop ▸ [your Mac] ▸ Rosin opens the Web Inspector on the app.
In the console, `Rosin.state()` shows what the menubar sees and
`Rosin.selectors` lists the selectors in use. Messages from the page script
show up in Console.app, prefixed `[Rosin/page]`.

## Notes

- Closing the window hides it; playback continues. Quit with ⌘Q or from the menubar.
- Audio goes through WebKit and the system mixer, so there's no exclusive or
  bit-perfect mode.
- If the site returns 403 errors, check System Settings ▸ Wi-Fi ▸ Details for
  "Limit IP address tracking".
