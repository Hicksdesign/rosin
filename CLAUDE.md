# Rosin

A personal macOS menubar companion for the **Qobuz desktop app** (Electron). It
patches Qobuz to load a script that adds custom CSS/fonts and keyboard shortcuts
and reports the current track, keeps that patch in place across Qobuz updates,
and shows the track and playback controls in the menubar. Not for distribution.

It used to wrap the Qobuz web player in a `WKWebView`; that version is on the
`web-wrapper` branch. It was dropped because the web player lacks the desktop
app's audio options (Qobuz Connect speakers, hi-res output).

It was called QobuzShell until October 2026. Patcher still recognises the old
`qobuz-shell-loader` patch and replaces it, so Qobuz never runs both loaders.

## Build

The Xcode project is generated from `project.yml` with XcodeGen; don't hand-edit the
`.xcodeproj` (it's gitignored).

```sh
brew install xcodegen      # once
xcodegen generate          # after adding/removing files or changing project.yml
xcodebuild -project Rosin.xcodeproj -scheme Rosin -configuration Debug build
```

Target: macOS 14+, Swift 5.10, AppKit (no SwiftUI). Menubar-only (`LSUIElement`).
Not sandboxed — see the comment in `Resources/Rosin.entitlements` for why.

## Layout

| File | Role |
|---|---|
| `Sources/AppDelegate.swift` | Entry point; installs support files, starts the patcher, bridge and menubar item |
| `Sources/SupportFiles.swift` | Copies `loader.js` and writes `config.json` into `~/Library/Application Support/Rosin/` |
| `Sources/Patcher.swift` | Adds/removes the loader `<script>` in each Qobuz app's `app.html` and Rosin's icon for Qobuz; re-patches after updates; restarts Qobuz |
| `Sources/QobuzBridge.swift` | Unix-socket client for each running loader; `NowPlaying` model; posts `nowPlayingDidChange` |
| `Sources/StatusItemController.swift` | Menubar item: track, artwork, play/pause/next/previous, settings, patch status |
| `Sources/Updater.swift` | Sparkle updates; off until `SPARKLE_FEED_URL` and `SPARKLE_PUBLIC_KEY` are set in `project.yml` |
| `Sources/Onboarding.swift` | Launch alerts: first-run welcome (restart Qobuz if needed), and App Management with Try Again |
| `Sources/LoginItem.swift` | Launch at Login via `SMAppService`; on by default on the first Release launch |
| `Sources/Uninstaller.swift` | Uninstall Rosin…: unpatches, reloads Qobuz, deletes support files and settings, trashes the app |
| `Sources/AccentPickerView.swift` | The Finder-style row of accent colour dots in the menu |
| `Scripts/release.sh` | After exporting a notarized build: checks it, zips it into `~/Herd/rosin/releases/`, runs `generate_appcast`, lists what to upload |
| `Resources/loader.js` | Runs inside Qobuz: CSS/font injection with live reload, accent variables, full-size immersive cover, state reporting, commands, shortcuts |
| `Resources/Rosin.icon` | Rosin's app icon (Icon Composer; `ASSETCATALOG_COMPILER_APPICON_NAME: Rosin`) |
| `Resources/Qobuz.icon` | The icon Patcher gives Qobuz. Not a resource: the Compile Qobuz Icon build phase runs `actool` on it into `Resources/QobuzIcon/Assets.car` |
| `Resources/Assets.xcassets` | `MenuBar`: the menubar icon (template PDF) shown when there's no cover |
| `Resources/custom.css` | User styles; sets the `--rosin-accent*` colours |
| `Resources/Fonts/fonts.json` | Font manifest: `[{ "family", "file", "weight", "style" }]`. Currently Jacket Sans variable (WOFF2, roman + italic), under the OFL (`OFL.txt`, shipped alongside) |

## How it works

- **Qobuz's structure:** Electron, code unpacked in `Contents/Resources/app/` (no
  `app.asar`), and the integrity fuses are off (`EnableEmbeddedAsarIntegrityValidation`,
  `OnlyLoadAppFromAsar`), so an edited `app.html` loads. The main window has
  `nodeIntegration: true, contextIsolation: false` and a wide-open CSP.
- **The patch:** one `<script id="rosin-loader">` before
  `<script src="/bundle.js">` that `require()`s
  `~/Library/Application Support/Rosin/loader.js`. Everything else lives
  outside the bundle, so updates only lose that one line.
- **Qobuz's icon:** Patcher copies `QobuzIcon/Assets.car` into Qobuz's
  `Contents/Resources/` and adds `CFBundleIconName = Qobuz` and
  `RosinIcon = true` to its `Info.plist`. Qobuz's own `icon.icns`
  (`CFBundleIconFile`) is untouched; macOS prefers the asset catalog icon.
  `RosinIcon` marks it as Rosin's, so unpatching only removes its own, and a
  Qobuz that ships its own asset catalog is left alone. Finder updates
  straight away (Launch Services re-registration); a running Qobuz keeps its
  old Dock icon until it restarts.
- **Re-patching:** the bundle is replaced on every update. Patcher re-patches
  when a Qobuz app launches and every 60s. If it patched an app that was already
  running, the menu offers "Restart to Apply".
- **Paths:** `config.json` gives loader.js the paths to `custom.css` and `Fonts/`:
  Application Support overrides, else the project's `Resources/` in Debug, else
  the app bundle. loader.js watches the CSS file's folder and re-applies on save.
- **Use Custom Theme** (menu setting, on by default): saved in UserDefaults and
  passed as `theme` in `config.json`, so Qobuz starts with the right look before
  the bridge connects. Toggling rewrites the config and sends `reloadStyles`.
  Off means no custom.css, fonts or accent variables; the cover upgrade,
  shortcuts and reporting stay on.
- **Accent colours:** `legacy.css` hard-codes Qobuz's accents (~300 places,
  no variables). loader.js rewrites each use in the loaded sheet via the CSSOM
  to `var(--rosin-accent…, <original>)`; translucent uses become
  `rgb(from var(…) r g b / α)`, so any colour syntax works in the variable.
  The CSSOM serialises colours as `rgb(0, 112, 239)` and shorthands as
  longhands, which is what `ACCENTS` matches. `#0070ef` → `--rosin-accent`,
  `#00acff` (hover) → `--rosin-accent-hover`, `#ffcb74` (dark theme, also
  `--color-brand-60` in main.css) → `--rosin-accent-dark`. main.css already
  uses variables throughout.
- **Accent picker:** a row of dots in the menu (Finder's tag colours, Theme
  Default, and any colour via the colour panel). Saved in UserDefaults and
  passed as `accent` (`#rrggbb`) in `config.json`. loader.js sets it inline on
  `<html>`, overriding `custom.css`'s `:root` values for `--rosin-accent`,
  `-dark` and `--color-brand-60`, with `-hover` a `color-mix` 15% lighter.
  Theme Default clears it, so `custom.css` applies. Only with Use Custom Theme
  on. Clicks keep the menu open and send `setAccent`, which only sets the
  variables, so the colour changes straight away.
- **Immersive cover:** Qobuz uses the 600px `release.image.large`; loader.js
  layers the CDN's `_max.jpg` (the full-size master, e.g. 3000px) over it.
  There's no size in between (`_1200` 404s); `_org` is the raw upload.
- **Bridge:** loader.js listens on `Application Support/Rosin/sockets/<App Name>.sock`
  (`Qobuz.sock`, `Qobuz Beta.sock`). Newline-delimited JSON:
  page → Swift `{type: "nowPlaying" | "log", ...}`, Swift → page `{command, argument}`.
  The bridge scans for new sockets every 2s.
- **Playback:** the audio engine is native (`juce.node` in the main process), so
  the page has no media element and no Media Session. State and control come
  from the player bar, which reflects every output, Qobuz Connect included.
- **Debugging:** `window.Rosin.state()` and friends in the page console.
  Getting a console: Qobuz has a `toggleDevTools` window method, but its trigger
  isn't known yet. Launching with `--remote-debugging-port=9222` is the
  fallback; then `http://127.0.0.1:9222/json` lists the page, and a small Node
  script can run `Runtime.evaluate` over its WebSocket to test code live.

## Status

Done:

1. Patch and loader verified in Qobuz 8.3.0-b028 and Qobuz Beta 8.3.0-b026:
   CSS and fonts apply, `custom.css` reloads live, sockets connect, and the
   player-bar selectors report title, artist, album, artwork and paused state.
2. Writing into the bundles worked without an App Management prompt on this Mac.
3. Menubar play/pause/next/previous and the ⌘F, ⌘←/→, ⌘[/] and Escape shortcuts work.
4. The immersive view shows the full-size (`_max.jpg`) cover.
5. Use Custom Theme toggles CSS, fonts and accents live.
6. Accent variables recolour legacy.css (tested live: 421 declarations).

To verify:

- The `playing` state on a Connect output; Open Immersive View on Play.
- The accent picker in the menu (the inline variables were tested live; the
  menu view, and changes reaching Qobuz while the menu is open, weren't).
- Re-patching after a real Qobuz update.

To do:

- Sparkle: generate the EdDSA keys, host an appcast, and fill in
  `SPARKLE_FEED_URL` / `SPARKLE_PUBLIC_KEY` in `project.yml`.
- Rewrite `README.md`: it still describes the old web-player wrapper.
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
- Reloading the page (Reload Qobuz) does load a changed loader.js; there's no
  `require` cache problem (tested). Relaunching Rosin copies the new loader.js
  but doesn't reload Qobuz, so the page keeps the old one: a new command then
  logs `unknown command` until Reload Qobuz. Commands from a client that connects,
  sends and hangs up straight away used to be dropped about 1 time in 6:
  the loader's greeting hit EPIPE and Node discarded the unread command.
  The greeting is now delayed 100ms. To script commands, e.g.
  `printf '{"command":"reload"}\n' | nc -U ~/Library/Application\ Support/Rosin/sockets/Qobuz.sock`.

## Ideas, not yet done

- Global hotkeys in the companion (Qobuz already handles the media keys itself,
  via `globalShortcut`, so don't register those).

## Conventions

- Keep every Qobuz selector in the `SELECTORS` object in `loader.js`; nothing else
  should query Qobuz's DOM directly. Take selectors from Qobuz's `bundle.js`
  (`Contents/Resources/app/node_modules/@qobuz/qobuz-dwp-ui/dist/`) where possible.
- Keep every in-app shortcut in `SHORTCUTS` in `loader.js`.
- Keep every hard-coded Qobuz colour that gets a variable in `ACCENTS` in `loader.js`.
- Explain the reasoning when making fixes, not just the change.
