import AppKit

/// The menubar item: shows the current track, offers playback controls, and
/// shows whether each Qobuz app is patched.
final class StatusItemController: NSObject, NSMenuDelegate {
    /// Set to false to show only the icon in the menubar.
    static let showsTrackTitle = true
    static let maxTitleLength = 32

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let bridge: QobuzBridge
    private let patcher: Patcher

    private let menu = NSMenu()
    private let trackItem = NSMenuItem()
    private let detailItem = NSMenuItem()
    private let playPauseItem = NSMenuItem()
    private let immersiveItem = NSMenuItem()
    /// Patch status items are rebuilt each time the menu opens, after this one.
    private let patchSectionStart = NSMenuItem.separator()

    private var artworkCache: [URL: NSImage] = [:]
    private var artworkTask: URLSessionDataTask?

    init(bridge: QobuzBridge, patcher: Patcher) {
        self.bridge = bridge
        self.patcher = patcher
        super.init()
        buildMenu()
        menu.delegate = self
        statusItem.menu = menu
        statusItem.button?.imagePosition = .imageLeading

        NotificationCenter.default.addObserver(
            self, selector: #selector(nowPlayingChanged),
            name: QobuzBridge.nowPlayingDidChange, object: bridge
        )
        update(with: bridge.nowPlaying)
    }

    // MARK: Menu

    private func buildMenu() {
        // Clicking the track or its details brings Qobuz forward.
        for item in [trackItem, detailItem] {
            item.action = #selector(showQobuz)
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(.separator())

        playPauseItem.action = #selector(togglePlayPause)
        playPauseItem.target = self
        menu.addItem(playPauseItem)
        menu.addItem(actionItem("Next Track", #selector(nextTrack), symbol: "forward.fill"))
        menu.addItem(actionItem("Previous Track", #selector(previousTrack), symbol: "backward.fill"))
        menu.addItem(.separator())

        // A setting rather than an action: the checkmark shows whether it's on.
        immersiveItem.title = "Open Immersive View on Play"
        immersiveItem.action = #selector(toggleOpenImmersiveOnPlay)
        immersiveItem.target = self
        menu.addItem(immersiveItem)
        menu.addItem(.separator())

        menu.addItem(actionItem("Show Qobuz", #selector(showQobuz)))
        menu.addItem(actionItem("Reload Qobuz", #selector(reloadQobuz)))
        menu.addItem(patchSectionStart)
        // Patch status goes here (menuNeedsUpdate).
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit QobuzShell", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func actionItem(_ title: String, _ action: Selector, symbol: String? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        if let symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
        return item
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        immersiveItem.state = bridge.opensImmersiveOnPlay ? .on : .off
        rebuildPatchSection()
    }

    /// One line per installed Qobuz app, plus the matching action.
    private func rebuildPatchSection() {
        let start = menu.index(of: patchSectionStart) + 1
        while menu.items[start].isSeparatorItem == false {
            menu.removeItem(at: start)
        }

        var items: [NSMenuItem] = []
        var needsPermission = false
        for app in patcher.apps {
            let isRunning = app.runningInstance != nil
            let isConnected = bridge.connectedApps.contains(app.name)
            let item: NSMenuItem
            switch patcher.statuses[app.bundleID] ?? .unpatched {
            case .patched where isConnected:
                item = infoItem("\(app.name): styles active", symbol: "checkmark.circle")
            case .patched where isRunning:
                // Patched after it launched (usually just after an update).
                item = actionItem("\(app.name): Restart to Apply", #selector(restartApp(_:)), symbol: "arrow.clockwise.circle")
                item.representedObject = app.bundleID
            case .patched:
                item = infoItem("\(app.name): patched", symbol: "checkmark.circle")
            case .failed(let reason):
                item = infoItem("\(app.name): \(reason)", symbol: "exclamationmark.triangle")
                needsPermission = needsPermission || reason.contains("App Management")
            case .unpatched:
                item = infoItem("\(app.name): not patched", symbol: "circle")
            }
            items.append(item)
        }
        if patcher.apps.isEmpty {
            items.append(infoItem("No Qobuz app found", symbol: "exclamationmark.triangle"))
        }
        if needsPermission {
            items.append(actionItem("Open App Management Settings…", #selector(openAppManagementSettings)))
        }
        let anyPatched = patcher.statuses.values.contains(.patched)
        items.append(anyPatched
            ? actionItem("Remove Patch from Qobuz", #selector(unpatch))
            : actionItem("Patch Qobuz", #selector(patch)))

        for (offset, item) in items.enumerated() {
            menu.insertItem(item, at: start + offset)
        }
    }

    private func infoItem(_ title: String, symbol: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        item.isEnabled = false
        return item
    }

    // MARK: Updates

    @objc private func nowPlayingChanged() {
        update(with: bridge.nowPlaying)
    }

    private func update(with np: NowPlaying) {
        guard let button = statusItem.button else { return }

        let symbol = np.hasTrack && np.isPlaying ? "waveform" : "music.note"
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Qobuz")

        if Self.showsTrackTitle, np.hasTrack {
            let text = np.artist.isEmpty ? np.title : "\(np.artist) – \(np.title)"
            button.title = " " + truncated(text)
        } else {
            button.title = ""
        }
        button.toolTip = np.hasTrack ? "\(np.title)\n\(np.artist)" : "Qobuz"

        trackItem.attributedTitle = NSAttributedString(
            string: np.hasTrack ? np.title : "Nothing playing",
            attributes: [.font: NSFont.menuFont(ofSize: 0).withWeight(.semibold)]
        )
        let detail = [np.artist, np.album].filter { !$0.isEmpty }.joined(separator: " — ")
        detailItem.title = detail
        detailItem.isHidden = detail.isEmpty

        playPauseItem.title = np.isPlaying ? "Pause" : "Play"
        playPauseItem.image = NSImage(systemSymbolName: np.isPlaying ? "pause.fill" : "play.fill", accessibilityDescription: nil)

        loadArtwork(np.artworkURL)
    }

    private func truncated(_ text: String) -> String {
        text.count > Self.maxTitleLength ? String(text.prefix(Self.maxTitleLength - 1)) + "…" : text
    }

    private func loadArtwork(_ url: URL?) {
        artworkTask?.cancel()
        guard let url else { trackItem.image = nil; return }
        if let cached = artworkCache[url] { trackItem.image = cached; return }

        artworkTask = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let image = NSImage(data: data) else { return }
            image.size = NSSize(width: 40, height: 40)
            DispatchQueue.main.async {
                self?.artworkCache[url] = image
                if self?.bridge.nowPlaying.artworkURL == url { self?.trackItem.image = image }
            }
        }
        artworkTask?.resume()
    }

    // MARK: Actions

    @objc private func togglePlayPause() { bridge.call("togglePlay") }
    @objc private func nextTrack() { bridge.call("next") }
    @objc private func previousTrack() { bridge.call("previous") }

    @objc private func toggleOpenImmersiveOnPlay() {
        bridge.opensImmersiveOnPlay.toggle()
    }

    /// Brings forward the Qobuz app the menubar is following, or any running
    /// one, or opens the first installed one.
    @objc private func showQobuz() {
        let apps = patcher.apps
        let target = apps.first { bridge.connectedApps.contains($0.name) && $0.runningInstance != nil }
            ?? apps.first { $0.runningInstance != nil }
        if let running = target?.runningInstance {
            running.activate()
        } else if let app = apps.first {
            NSWorkspace.shared.openApplication(at: app.url, configuration: .init())
        }
    }

    /// Picks up a new loader.js (as well as CSS and fonts) without restarting Qobuz.
    @objc private func reloadQobuz() {
        SupportFiles.install()
        bridge.callAll("reload")
    }

    @objc private func restartApp(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let app = patcher.apps.first(where: { $0.bundleID == id }) else { return }
        patcher.restart(app)
    }

    @objc private func patch() { patcher.patchAll() }
    @objc private func unpatch() { patcher.unpatchAll() }
    @objc private func openAppManagementSettings() { Patcher.openAppManagementSettings() }
}

private extension NSFont {
    func withWeight(_ weight: NSFont.Weight) -> NSFont {
        let descriptor = fontDescriptor.addingAttributes([.traits: [NSFontDescriptor.TraitKey.weight: weight]])
        return NSFont(descriptor: descriptor, size: pointSize) ?? self
    }
}
