# QobuzShell

A personal macOS app that wraps the Qobuz web player (https://play.qobuz.com) in a
native AppKit window with a `WKWebView`, adding custom CSS/fonts, keyboard shortcuts
and a menubar now-playing item. Not for distribution.

## Build

The Xcode project is generated from `project.yml` with XcodeGen; don't hand-edit the
`.xcodeproj` (it's gitignored).

```sh
brew install xcodegen      # once
xcodegen generate          # after adding/removing files or changing project.yml
xcodebuild -project QobuzShell.xcodeproj -scheme QobuzShell -configuration Debug build
```

Target: macOS 14+, Swift 5.10, AppKit (no SwiftUI). Not sandboxed — see the
comment in `Resources/QobuzShell.entitlements` for why.

## Layout

| File | Role |
|---|---|
| `Sources/AppDelegate.swift` | Entry point; window hides instead of closing so playback continues |
| `Sources/BrowserWindowController.swift` | The `WKWebView`, hidden title bar + drag strip, navigation policy (non-Qobuz links → default browser), menu actions |
| `Sources/MainMenu.swift` | Menu bar and **all keyboard shortcuts** |
| `Sources/WebBridge.swift` | Swift ↔ page bridge; `NowPlaying` model; posts `nowPlayingDidChange` |
| `Sources/UserStyles.swift` | Loads `inject.js`, `custom.css`, fonts (override → source tree in Debug → bundle) |
| `Sources/StatusItemController.swift` | Menubar item: track, artwork, play/pause/next/previous |
| `Resources/inject.js` | Page script: commands on `window.QobuzShell`, state reporting, CSS/font injection |
| `Resources/custom.css` | User styles, scoped under `html.qobuz-shell` |
| `Resources/Fonts/fonts.json` | Font manifest: `[{ "family", "file", "weight", "style" }]`. Currently Jacket Sans variable (WOFF2, roman + italic) |

## How the bridge works

- Swift → page: `bridge.call("togglePlay")` evaluates `window.QobuzShell.togglePlay()`.
- Page → Swift: `webkit.messageHandlers.qobuzShell.postMessage({type: "nowPlaying" | "log", ...})`.
- Playback control prefers **captured Media Session action handlers** (inject.js wraps
  `navigator.mediaSession.setActionHandler` at document start), then DOM buttons,
  then the raw media element. Track info prefers `navigator.mediaSession.metadata`,
  then DOM selectors.
- CSS uses a constructed stylesheet (`adoptedStyleSheets`); fonts are passed as bytes
  to the `FontFace` API. Both get past the site's CSP (verified).
- Font bytes are base64'd into the user script on every load, so keep the manifest
  small: variable WOFF2 rather than static files.

## Window chrome

The title bar is hidden (`.fullSizeContentView`, transparent, no title), so the page
runs up under the traffic lights. Two consequences:

- A `WKWebView` takes every click, so a native `TitlebarDragView` strip (standard
  title bar height, 28pt) sits on top to drag the window and handle double-click per
  the system setting. Nothing under that strip is clickable.
- Swift sets `--qobuz-shell-titlebar-height` on `<html>` (`0px` in full screen);
  `custom.css` uses it to pad Qobuz's layout clear of the strip.

## Status

Done:

1. Builds cleanly with XcodeGen + Xcode.
2. Qobuz registers Media Session handlers for `play`, `pause`, `nexttrack` and
   `previoustrack`, and sets `mediaSession.metadata`, so playback control and track
   info work without DOM selectors (`QobuzShell.state()` → `source: "mediaSession"`).
   `QobuzShell.handlers()` lists the captured actions.
3. Real selectors for the full player and search. Qobuz uses readable BEM classes
   (`FullPlayer__close`, `SearchBar__input`) — prefer those; aria-labels are
   localised, so only use them as a secondary match. The player-bar fallback
   selectors are still unverified placeholders.
4. CSS and font injection get past the CSP.
5. Title bar hidden; window drags from the top strip.

To do:

- `custom.css` padding for the traffic lights using `--qobuz-shell-titlebar-height`.
- App icon in `Resources/Assets.xcassets/AppIcon.appiconset`.

Gotchas found so far:

- Qobuz's icons are an icon font on `icon-*` / `pct` classes. Broad `font-family`
  rules must exclude them or the icons render as letters.
- On Discover, focusing search opens a history panel that re-renders the bar and
  drops focus; `focusSearch` refocuses after 100ms.
- With the system output set to AirPlay, 192 kHz streams stall (spinner, time
  resets to 0:00) in WebKit, Safari included; 96 kHz plays. Local playback uses
  MSE, and Firefox resamples in its own stack so it doesn't hit this. Keep Qobuz's
  quality at 96 kHz. The `file/url` API calls are signed, so the format can't be
  rewritten in flight.
- Debug builds read `inject.js`, `custom.css` and fonts from the source tree:
  ⌘R reloads the page with fresh scripts, ⌘⇧R re-applies CSS and fonts.

## Ideas, not yet done

- Feed `NowPlaying` into `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` for
  Control Center and media keys (check first whether WebKit already does this
  from the page's Media Session, to avoid duplicates).
- File watcher on `custom.css` for automatic reload instead of ⌘⇧R.

## Conventions

- Keep every selector in the `SELECTORS` object in `inject.js`; nothing else should
  query Qobuz's DOM directly.
- Keep every shortcut in `MainMenu.swift`.
- Explain the reasoning when making fixes, not just the change.
