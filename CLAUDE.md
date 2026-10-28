# QobuzShell

A personal macOS menubar companion for the **Qobuz desktop app** (Electron). It
patches Qobuz to load a script that adds custom CSS/fonts and keyboard shortcuts
and reports the current track, keeps that patch in place across Qobuz updates,
and shows the track and playback controls in the menubar. Not for distribution.

It used to wrap the Qobuz web player in a `WKWebView`; that version is on the
`web-wrapper` branch. It was dropped because the web player lacks the desktop
app's audio options (Qobuz Connect speakers, hi-res output).

## Build

The Xcode project is generated from `project.yml` with XcodeGen; don't hand-edit the
`.xcodeproj` (it's gitignored).

```sh
brew install xcodegen      # once
xcodegen generate          # after adding/removing files or changing project.yml
xcodebuild -project QobuzShell.xcodeproj -scheme QobuzShell -configuration Debug build
```

Target: macOS 14+, Swift 5.10, AppKit (no SwiftUI). Menubar-only (`LSUIElement`).
Not sandboxed — see the comment in `Resources/QobuzShell.entitlements` for why.

## Layout

| File | Role |
|---|---|
| `Sources/AppDelegate.swift` | Entry point; installs support files, starts the patcher, bridge and menubar item |
| `Sources/SupportFiles.swift` | Copies `loader.js` and writes `config.json` into `~/Library/Application Support/QobuzShell/` |
| `Sources/Patcher.swift` | Adds/removes the loader `<script>` in each Qobuz app's `app.html`; re-patches after updates; restarts Qobuz |
| `Sources/QobuzBridge.swift` | Unix-socket client for each running loader; `NowPlaying` model; posts `nowPlayingDidChange` |
| `Sources/StatusItemController.swift` | Menubar item: track, artwork, play/pause/next/previous, settings, patch status |
| `Resources/loader.js` | Runs inside Qobuz: CSS/font injection with live reload, state reporting, commands, shortcuts |
| `Resources/custom.css` | User styles |
| `Resources/Fonts/fonts.json` | Font manifest: `[{ "family", "file", "weight", "style" }]`. Currently Jacket Sans variable (WOFF2, roman + italic) |

## How it works

- **Qobuz's structure:** Electron, code unpacked in `Contents/Resources/app/` (no
  `app.asar`), and the integrity fuses are off (`EnableEmbeddedAsarIntegrityValidation`,
  `OnlyLoadAppFromAsar`), so an edited `app.html` loads. The main window has
  `nodeIntegration: true, contextIsolation: false` and a wide-open CSP.
- **The patch:** one `<script id="qobuz-shell-loader">` before
  `<script src="/bundle.js">` that `require()`s
  `~/Library/Application Support/QobuzShell/loader.js`. Everything else lives
  outside the bundle, so updates only lose that one line.
- **Re-patching:** the bundle is replaced on every update. Patcher re-patches
  when a Qobuz app launches and every 60s. If it patched an app that was already
  running, the menu offers "Restart to Apply".
- **Paths:** `config.json` gives loader.js the paths to `custom.css` and `Fonts/`:
  Application Support overrides, else the project's `Resources/` in Debug, else
  the app bundle. loader.js watches the CSS file's folder and re-applies on save.
- **Bridge:** loader.js listens on `Application Support/QobuzShell/sockets/<App Name>.sock`
  (`Qobuz.sock`, `Qobuz Beta.sock`). Newline-delimited JSON:
  page → Swift `{type: "nowPlaying" | "log", ...}`, Swift → page `{command, argument}`.
  The bridge scans for new sockets every 2s.
- **Playback:** the audio engine is native (`juce.node` in the main process), so
  the page has no media element and no Media Session. State and control come
  from the player bar, which reflects every output, Qobuz Connect included.
- **Debugging:** `window.QobuzShell.state()` and friends in the page console.
  Getting a console: Qobuz has a `toggleDevTools` window method, but its trigger
  isn't known yet. Launching with `--remote-debugging-port` is the fallback.

## Status

Done:

1. Patch and loader verified in Qobuz 8.3.0-b028 and Qobuz Beta 8.3.0-b026:
   CSS and fonts apply, `custom.css` reloads live, sockets connect, and the
   player-bar selectors report title, artist, album, artwork and paused state.
2. Writing into the bundles worked without an App Management prompt on this Mac.
3. Menubar play/pause/next/previous and the ⌘F, ⌘←/→, ⌘[/] and Escape shortcuts work.

To verify:

- Whether Reload Qobuz picks up a changed loader.js: a ⌘[/] fix only took
  effect after restarting Qobuz, so the renderer may be keeping the old
  module in Node's `require` cache across reloads.
- The `playing` state on a Connect output; Open Immersive View on Play.
- Re-patching after a real Qobuz update.

To do:

- App icon in `Resources/Assets.xcassets/AppIcon.appiconset`.
- Find what triggers Qobuz's `toggleDevTools`, for an easy page console.

Gotchas found so far:

- Launching Qobuz and Qobuz Beta together made both quit (no crash report).
  Looks like Qobuz's own conflict; run one at a time.
- Qobuz's icons are an icon font on `icon-*` / `pct` classes. Broad `font-family`
  rules must exclude them or the icons render as letters.
- On Discover, focusing search opens a history panel that re-renders the bar and
  drops focus; `openSearch` refocuses after 100ms.
- loader.js runs with full Node access inside Qobuz: only ever load our own files.
- Qobuz navigates with its own in-app history (Redux `handlePrevious`/`handleNext`
  in the nav bar), not `window.history`, so `history.back()` does nothing. Back
  and forward click the nav bar arrows (`icon-arrow-navigation-back`/`-forward`).
  In general, prefer clicking Qobuz's own controls over browser APIs.

## Ideas, not yet done

- Global hotkeys in the companion (Qobuz already handles the media keys itself,
  via `globalShortcut`, so don't register those).

## Conventions

- Keep every Qobuz selector in the `SELECTORS` object in `loader.js`; nothing else
  should query Qobuz's DOM directly. Take selectors from Qobuz's `bundle.js`
  (`Contents/Resources/app/node_modules/@qobuz/qobuz-dwp-ui/dist/`) where possible.
- Keep every in-app shortcut in `SHORTCUTS` in `loader.js`.
- Explain the reasoning when making fixes, not just the change.
