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
| `Sources/BrowserWindowController.swift` | The `WKWebView`, navigation policy (non-Qobuz links → default browser), menu actions |
| `Sources/MainMenu.swift` | Menu bar and **all keyboard shortcuts** |
| `Sources/WebBridge.swift` | Swift ↔ page bridge; `NowPlaying` model; posts `nowPlayingDidChange` |
| `Sources/UserStyles.swift` | Loads `inject.js`, `custom.css`, fonts (override → source tree in Debug → bundle) |
| `Sources/StatusItemController.swift` | Menubar item: track, artwork, play/pause/next/previous |
| `Resources/inject.js` | Page script: commands on `window.QobuzShell`, state reporting, CSS/font injection |
| `Resources/custom.css` | User styles, scoped under `html.qobuz-shell` |
| `Resources/Fonts/fonts.json` | Font manifest: `[{ "family", "file", "weight", "style" }]` |

## How the bridge works

- Swift → page: `bridge.call("togglePlay")` evaluates `window.QobuzShell.togglePlay()`.
- Page → Swift: `webkit.messageHandlers.qobuzShell.postMessage({type: "nowPlaying" | "log", ...})`.
- Playback control prefers **captured Media Session action handlers** (inject.js wraps
  `navigator.mediaSession.setActionHandler` at document start), then DOM buttons,
  then the raw media element. Track info prefers `navigator.mediaSession.metadata`,
  then DOM selectors.
- CSS uses a constructed stylesheet (`adoptedStyleSheets`); fonts are passed as bytes
  to the `FontFace` API. Both are meant to sidestep the site's CSP.

## Status / first tasks

The Swift code has **not been compiled yet** (it was written without a Mac toolchain),
and the DOM selectors in `inject.js` are **placeholders**. In order:

1. `xcodegen generate`, build, fix any compile errors.
2. Sign in and play something. In Safari ▸ Develop ▸ [Mac] ▸ QobuzShell, run
   `QobuzShell.state()` — check whether `source` is `"mediaSession"` or `"dom"`, and
   whether Qobuz registers Media Session handlers at all.
3. Replace the placeholder `SELECTORS` in `inject.js` with real ones (immersive view,
   close button, search field/button, and player-bar fallbacks). Prefer aria-labels,
   roles and data attributes over generated class names.
4. Confirm the CSS and font injection actually get past Qobuz's CSP.
5. Add an app icon to `Resources/Assets.xcassets/AppIcon.appiconset`.

## Ideas, not yet done

- Feed `NowPlaying` into `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` for
  Control Center and media keys (check first whether WebKit already does this
  from the page's Media Session, to avoid duplicates).
- File watcher on `custom.css` for automatic reload instead of ⌘⇧R.
- Hidden title bar (`.fullSizeContentView`) with CSS padding for the traffic lights.

## Conventions

- Keep every selector in the `SELECTORS` object in `inject.js`; nothing else should
  query Qobuz's DOM directly.
- Keep every shortcut in `MainMenu.swift`.
- Explain the reasoning when making fixes, not just the change.
