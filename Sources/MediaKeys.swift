import AppKit
import MediaPlayer

/// Makes Rosin the system's Now Playing app for Qobuz, so the media keys (and
/// AirPods, Control Center and the lock screen) control it.
///
/// Qobuz registers the media keys itself with Electron's globalShortcut, but on
/// macOS that only works if Qobuz has Accessibility permission, which it asks
/// for once ("never ask me again"). Its native audio engine doesn't publish
/// Now Playing info either, so without this the keys go to whichever app last
/// did, e.g. Music. MPRemoteCommandCenter needs no permission.
///
/// If Qobuz does have Accessibility permission, its event tap should see the
/// key first and swallow it, so a press isn't handled twice (not yet verified).
final class MediaKeys {
    private let bridge: QobuzBridge
    private let center = MPNowPlayingInfoCenter.default()
    private var artwork: (url: URL, artwork: MPMediaItemArtwork)?
    private var artworkTask: URLSessionDataTask?

    init(bridge: QobuzBridge) {
        self.bridge = bridge
        let commands = MPRemoteCommandCenter.shared()
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in self?.run("togglePlay") ?? .commandFailed }
        commands.playCommand.addTarget { [weak self] _ in self?.run("togglePlay", unless: true) ?? .commandFailed }
        commands.pauseCommand.addTarget { [weak self] _ in self?.run("togglePlay", unless: false) ?? .commandFailed }
        commands.nextTrackCommand.addTarget { [weak self] _ in self?.run("next") ?? .commandFailed }
        commands.previousTrackCommand.addTarget { [weak self] _ in self?.run("previous") ?? .commandFailed }

        NotificationCenter.default.addObserver(
            self, selector: #selector(nowPlayingChanged),
            name: QobuzBridge.nowPlayingDidChange, object: bridge
        )
        update(with: bridge.nowPlaying)
    }

    /// Sends a loader.js command, skipped if Qobuz's playing state already
    /// equals `unless` (play while playing, pause while paused): Qobuz only
    /// has a toggle.
    private func run(_ command: String, unless playing: Bool? = nil) -> MPRemoteCommandHandlerStatus {
        let np = bridge.nowPlaying
        guard np.hasTrack else { return .noActionableNowPlayingItem }
        if np.isPlaying != playing { bridge.call(command) }
        return .success
    }

    @objc private func nowPlayingChanged() {
        update(with: bridge.nowPlaying)
    }

    private func update(with np: NowPlaying) {
        // With no track (Qobuz closed or nothing loaded), step aside so the
        // keys go to other apps.
        guard np.hasTrack else {
            artworkTask?.cancel()
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: np.title,
            MPMediaItemPropertyArtist: np.artist,
            MPMediaItemPropertyAlbumTitle: np.album,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let artwork, artwork.url == np.artworkURL {
            info[MPMediaItemPropertyArtwork] = artwork.artwork
        } else {
            loadArtwork(np.artworkURL)
        }
        center.nowPlayingInfo = info
        center.playbackState = np.isPlaying ? .playing : .paused
    }

    private func loadArtwork(_ url: URL?) {
        artworkTask?.cancel()
        guard let url else { return }
        artworkTask = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let image = NSImage(data: data) else { return }
            DispatchQueue.main.async {
                guard let self, self.bridge.nowPlaying.artworkURL == url else { return }
                let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.artwork = (url, artwork)
                self.update(with: self.bridge.nowPlaying)
            }
        }
        artworkTask?.resume()
    }
}
