import AppKit

/// The menubar item: shows the current track and offers playback controls.
final class StatusItemController: NSObject {
    /// Set to false to show only the icon in the menubar.
    static let showsTrackTitle = true
    static let maxTitleLength = 32

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let bridge: WebBridge
    private let showWindow: () -> Void

    private let menu = NSMenu()
    private let trackItem = NSMenuItem()
    private let detailItem = NSMenuItem()
    private let playPauseItem = NSMenuItem()

    private var artworkCache: [URL: NSImage] = [:]
    private var artworkTask: URLSessionDataTask?

    init(bridge: WebBridge, showWindow: @escaping () -> Void) {
        self.bridge = bridge
        self.showWindow = showWindow
        super.init()
        buildMenu()
        statusItem.menu = menu
        statusItem.button?.imagePosition = .imageLeading

        NotificationCenter.default.addObserver(
            self, selector: #selector(nowPlayingChanged),
            name: WebBridge.nowPlayingDidChange, object: bridge
        )
        update(with: bridge.nowPlaying)
    }

    // MARK: Menu

    private func buildMenu() {
        // Clicking the track or its details brings the window forward.
        for item in [trackItem, detailItem] {
            item.action = #selector(showWindowAction)
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
        menu.addItem(actionItem("Show Qobuz", #selector(showWindowAction)))
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func actionItem(_ title: String, _ action: Selector, symbol: String? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        if let symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
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
    @objc private func showWindowAction() { showWindow() }
}

private extension NSFont {
    func withWeight(_ weight: NSFont.Weight) -> NSFont {
        let descriptor = fontDescriptor.addingAttributes([.traits: [NSFontDescriptor.TraitKey.weight: weight]])
        return NSFont(descriptor: descriptor, size: pointSize) ?? self
    }
}
