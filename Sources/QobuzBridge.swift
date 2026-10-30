import Foundation
import Network

/// What loader.js reports about the current track.
struct NowPlaying: Equatable {
    var title = ""
    var artist = ""
    var album = ""
    var artworkURL: URL?
    var isPlaying = false
    /// Which source the metadata came from ("dom" for now). Handy when debugging selectors.
    var source = ""

    var hasTrack: Bool { !title.isEmpty }
}

/// Link to loader.js running in each patched Qobuz app, over the Unix sockets
/// it creates in Application Support/Rosin/sockets/.
///  - Swift → page: `call("togglePlay")` sends {"command": "togglePlay"}.
///  - Page → Swift: {"type": "nowPlaying" | "log", ...}.
/// Both directions are newline-delimited JSON.
///
/// If both Qobuz and Qobuz Beta are running, the menubar follows whichever is
/// playing, or else whichever changed track most recently.
final class QobuzBridge {
    static let nowPlayingDidChange = Notification.Name("Rosin.nowPlayingDidChange")
    static let connectionsDidChange = Notification.Name("Rosin.connectionsDidChange")

    private final class Connection {
        let name: String
        let nw: NWConnection
        var buffer = Data()
        var nowPlaying = NowPlaying()
        var changedAt = Date.distantPast

        init(name: String, nw: NWConnection) {
            self.name = name
            self.nw = nw
        }
    }

    private var connections: [String: Connection] = [:]   // by socket name, e.g. "Qobuz Beta"
    private var timer: Timer?

    /// Names of the Qobuz apps with a live loader, e.g. ["Qobuz Beta"].
    var connectedApps: Set<String> { Set(connections.keys) }

    private(set) var nowPlaying = NowPlaying() {
        didSet {
            guard nowPlaying != oldValue else { return }
            NotificationCenter.default.post(name: Self.nowPlayingDidChange, object: self)
        }
    }

    /// Open Immersive View on Play. Saved in UserDefaults and sent to each
    /// loader as it connects.
    private static let openImmersiveOnPlayKey = "openImmersiveOnPlay"
    var opensImmersiveOnPlay = UserDefaults.standard.bool(forKey: openImmersiveOnPlayKey) {
        didSet {
            UserDefaults.standard.set(opensImmersiveOnPlay, forKey: Self.openImmersiveOnPlayKey)
            for connection in connections.values { sendImmersiveSetting(to: connection) }
        }
    }

    init() {
        // Sockets come and go as Qobuz launches, quits and reloads. Checking the
        // folder every couple of seconds is simpler than watching it, and cheap.
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.connectToNewSockets() }
        connectToNewSockets()
    }

    // MARK: Connecting

    private func connectToNewSockets() {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: SupportFiles.socketsDirectory, includingPropertiesForKeys: nil
        )) ?? []
        for url in files where url.pathExtension == "sock" {
            let name = url.deletingPathExtension().lastPathComponent
            guard connections[name] == nil else { continue }
            connect(name: name, path: url.path)
        }
    }

    private func connect(name: String, path: String) {
        let nw = NWConnection(to: .unix(path: path), using: .tcp)
        let connection = Connection(name: name, nw: nw)
        connections[name] = connection

        nw.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .ready:
                NSLog("[Rosin] Connected to \(name)")
                self.sendImmersiveSetting(to: connection)
                NotificationCenter.default.post(name: Self.connectionsDidChange, object: self)
            case .failed, .cancelled, .waiting:
                // .waiting means nothing is listening: a stale socket from a
                // Qobuz that has quit. Drop it; the next scan retries.
                self.drop(connection)
            default:
                break
            }
        }
        receive(on: connection)
        nw.start(queue: .main)
    }

    private func drop(_ connection: Connection) {
        guard connections[connection.name] === connection else { return }
        connection.nw.cancel()
        connections[connection.name] = nil
        updateNowPlaying()
        NotificationCenter.default.post(name: Self.connectionsDidChange, object: self)
    }

    // MARK: Page → Swift

    private func receive(on connection: Connection) {
        connection.nw.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self, weak connection] data, _, isComplete, error in
            guard let self, let connection else { return }
            if let data {
                connection.buffer.append(data)
                while let newline = connection.buffer.firstIndex(of: UInt8(ascii: "\n")) {
                    let line = connection.buffer[connection.buffer.startIndex..<newline]
                    connection.buffer.removeSubrange(connection.buffer.startIndex...newline)
                    self.handle(line: Data(line), from: connection)
                }
            }
            if isComplete || error != nil {
                self.drop(connection)
            } else {
                self.receive(on: connection)
            }
        }
    }

    private func handle(line: Data, from connection: Connection) {
        guard let body = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              let type = body["type"] as? String else { return }

        switch type {
        case "nowPlaying":
            let artwork = (body["artwork"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
            let np = NowPlaying(
                title: body["title"] as? String ?? "",
                artist: body["artist"] as? String ?? "",
                album: body["album"] as? String ?? "",
                artworkURL: artwork,
                isPlaying: body["playing"] as? Bool ?? false,
                source: body["source"] as? String ?? ""
            )
            if np != connection.nowPlaying {
                connection.nowPlaying = np
                connection.changedAt = Date()
            }
            updateNowPlaying()
        case "log":
            NSLog("[Rosin/\(connection.name)] \(body["message"] as? String ?? "")")
        default:
            break
        }
    }

    /// The app the menubar follows: a playing one first, then the most recent change.
    private var activeConnection: Connection? {
        connections.values.max { a, b in
            (a.nowPlaying.isPlaying ? 1 : 0, a.changedAt) < (b.nowPlaying.isPlaying ? 1 : 0, b.changedAt)
        }
    }

    private func updateNowPlaying() {
        nowPlaying = activeConnection?.nowPlaying ?? NowPlaying()
    }

    // MARK: Swift → page

    /// Runs a command in loader.js (see `commands` there) in the active app.
    func call(_ command: String) {
        guard let connection = activeConnection else { return }
        send(["command": command], to: connection)
    }

    /// Runs a command in every connected app.
    func callAll(_ command: String) {
        for connection in connections.values { send(["command": command], to: connection) }
    }

    private func sendImmersiveSetting(to connection: Connection) {
        send(["command": "setOpenImmersiveOnPlay", "argument": opensImmersiveOnPlay], to: connection)
    }

    private func send(_ message: [String: Any], to connection: Connection) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(UInt8(ascii: "\n"))
        connection.nw.send(content: data, completion: .contentProcessed { error in
            if let error { NSLog("[Rosin] Send to \(connection.name) failed: \(error)") }
        })
    }
}
