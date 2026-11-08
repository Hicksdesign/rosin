import AppKit
import CryptoKit

/// One installed Qobuz desktop app (release or beta).
struct QobuzApp: Equatable {
    var bundleID: String
    var url: URL

    /// "Qobuz" or "Qobuz Beta". Also names its socket (see loader.js).
    var name: String { url.deletingPathExtension().lastPathComponent }
    var appHTML: URL { url.appendingPathComponent("Contents/Resources/app/app.html") }
    var infoPlist: URL { url.appendingPathComponent("Contents/Info.plist") }
    var runningInstance: NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first
    }
}

/// Adds one <script> to each Qobuz app's app.html that loads loader.js from
/// Application Support.
///
/// Qobuz is Electron with its code unpacked in Contents/Resources/app, and the
/// fuses that would refuse modified files (asar integrity, load only from asar)
/// are off, so an edited app.html just loads. Each update replaces the whole
/// bundle, so the patch is re-applied whenever a Qobuz app launches and once a
/// minute.
///
/// It also swaps Qobuz's icon for Rosin's (see installIcon), re-applied the
/// same way.
///
/// Writing into another app's bundle needs the App Management permission
/// (System Settings ▸ Privacy & Security). Without it, writes fail with EPERM
/// and the status shows `.failed`.
final class Patcher {
    static let didChange = Notification.Name("Rosin.patcherDidChange")
    static let bundleIDs = ["com.qobuz.desktop", "com.qobuz.desktop.beta"]

    enum Status: Equatable {
        case patched, unpatched
        case failed(String)
    }

    /// The failure reason when macOS refuses the write (see describe).
    static let permissionReason = "Needs App Management permission"

    /// The failure reason for a Qobuz whose Info.plist an earlier Rosin edited
    /// (see hasBrokenSignature).
    static let brokenSignatureReason = "Needs reinstalling (an older Rosin broke it)"

    /// The marker id lets patch() spot an existing patch and unpatch() remove it.
    private static let marker = "rosin-loader"
    private static let snippet = """
        <script id="\(marker)">try{require(require('path').join(require('os').homedir(),'Library/Application Support/Rosin/loader.js'))}catch(e){console.error('[Rosin] loader failed',e)}</script>
        """
    /// The patch from before the app was renamed (QobuzShell). patch() swaps
    /// it for the current one, so Qobuz doesn't run two loaders, and unpatch()
    /// removes it too.
    private static let oldSnippets = [
        """
        <script id="qobuz-shell-loader">try{require(require('path').join(require('os').homedir(),'Library/Application Support/QobuzShell/loader.js'))}catch(e){console.error('[QobuzShell] loader failed',e)}</script>
        """,
    ]
    /// The loader goes in just before Qobuz's own bundle, so it's in place
    /// before the app renders. </body> is the fallback if that tag changes.
    private static let anchors = [#"<script src="/bundle.js"></script>"#, "</body>"]
    /// Keeps the anchor on its own line, at app.html's indentation.
    private static let separator = "\n    "

    private(set) var apps: [QobuzApp] = []
    private(set) var statuses: [String: Status] = [:]   // by bundle ID
    /// Set by unpatch() so the periodic check doesn't put the patch straight back.
    private var autoPatch = true
    private var timer: Timer?
    /// Apps restart() has quit, to open again once they've gone (by bundle ID).
    private var pendingRelaunch: Set<String> = []
    /// Apps patched while running, so still on the unpatched page until they
    /// restart (by bundle ID). Cleared when they quit.
    private(set) var patchedWhileRunning: Set<String> = []

    /// The apps that couldn't be patched or unpatched, and why.
    var failures: [(app: QobuzApp, reason: String)] {
        apps.compactMap { app in
            if case .failed(let reason) = statuses[app.bundleID] { return (app, reason) }
            return nil
        }
    }

    var appsNeedingPermission: [QobuzApp] {
        failures.filter { $0.reason == Self.permissionReason }.map(\.app)
    }

    init() {
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            center.addObserver(self, selector: #selector(appLaunchedOrQuit(_:)), name: name, object: nil)
        }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
    }

    @objc private func appLaunchedOrQuit(_ note: Notification) {
        let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        guard let id = app?.bundleIdentifier, Self.bundleIDs.contains(id) else { return }
        if note.name == NSWorkspace.didTerminateApplicationNotification { patchedWhileRunning.remove(id) }
        if note.name == NSWorkspace.didTerminateApplicationNotification, pendingRelaunch.remove(id) != nil,
           let app = apps.first(where: { $0.bundleID == id }) {
            NSWorkspace.shared.openApplication(at: app.url, configuration: .init())
        }
        // A Qobuz launch is often the first run after an update, so check now.
        refresh()
    }

    /// Finds the installed apps and (re)patches any that need it.
    func refresh() {
        apps = Self.bundleIDs.compactMap { id in
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).map { QobuzApp(bundleID: id, url: $0) }
        }
        for app in apps {
            statuses[app.bundleID] = autoPatch ? patch(app) : status(of: app)
        }
        NotificationCenter.default.post(name: Self.didChange, object: self)
    }

    func patchAll() {
        autoPatch = true
        refresh()
    }

    /// Returns the apps it couldn't unpatch, and why.
    @discardableResult
    func unpatchAll() -> [(app: QobuzApp, reason: String)] {
        autoPatch = false
        for app in apps { statuses[app.bundleID] = unpatch(app) }
        NotificationCenter.default.post(name: Self.didChange, object: self)
        return failures
    }

    // MARK: Patching

    private func status(of app: QobuzApp) -> Status {
        guard let html = try? String(contentsOf: app.appHTML, encoding: .utf8) else {
            return .failed("Can't read app.html")
        }
        return html.contains(Self.marker) ? .patched : .unpatched
    }

    private func patch(_ app: QobuzApp) -> Status {
        if Self.hasBrokenSignature(app) { return .failed(Self.brokenSignatureReason) }
        do {
            let original = try String(contentsOf: app.appHTML, encoding: .utf8)
            let html = Self.removing(Self.oldSnippets, from: original)
            if html.contains(Self.marker) {
                if html != original { try html.write(to: app.appHTML, atomically: true, encoding: .utf8) }
                try installIcon(app)
                return .patched
            }
            guard let anchor = Self.anchors.compactMap({ html.range(of: $0) }).first else {
                return .failed("app.html has changed; no place to add the loader")
            }
            var patched = html
            patched.insert(contentsOf: Self.snippet + Self.separator, at: anchor.lowerBound)
            try patched.write(to: app.appHTML, atomically: true, encoding: .utf8)
            if app.runningInstance != nil { patchedWhileRunning.insert(app.bundleID) }
            NSLog("[Rosin] Patched \(app.name)")
            try installIcon(app)
            return .patched
        } catch {
            return .failed(Self.describe(error))
        }
    }

    private func unpatch(_ app: QobuzApp) -> Status {
        do {
            let html = try String(contentsOf: app.appHTML, encoding: .utf8)
            // Undo exactly what patch() inserted.
            let restored = Self.removing([Self.snippet] + Self.oldSnippets, from: html)
            if restored != html {
                try restored.write(to: app.appHTML, atomically: true, encoding: .utf8)
                NSLog("[Rosin] Unpatched \(app.name)")
            }
            try removeIcon(app)
            return .unpatched
        } catch {
            return .failed(Self.describe(error))
        }
    }

    /// app.html without the given snippets, each with or without the separator after it.
    private static func removing(_ snippets: [String], from html: String) -> String {
        snippets.reduce(html) { html, snippet in
            html.replacingOccurrences(of: snippet + separator, with: "")
                .replacingOccurrences(of: snippet, with: "")
        }
    }

    // MARK: Icon

    /// Rosin's icon for Qobuz: Resources/Qobuz.icon, compiled to a flat .icns
    /// by the Compile Qobuz Icon build phase (see project.yml).
    private static let bundledIcon = Bundle.main.url(forResource: "Qobuz", withExtension: "icns", subdirectory: "QobuzIcon")
    /// An extended attribute on Qobuz's bundle folder holding a hash of the
    /// icon Rosin installed, so installIcon can tell when it's out of date and
    /// removeIcon only ever removes an icon Rosin installed.
    private static let iconMarker = "design.hicks.Rosin.icon"
    /// Earlier versions put the icon in Qobuz's Info.plist under this key.
    private static let legacyIconKey = "RosinIcon"

    /// Gives Qobuz Rosin's icon as a Finder custom icon, the same as pasting
    /// one in Get Info: an `Icon\r` file at the top of the bundle, which the
    /// Dock shows too.
    ///
    /// It can't be the asset catalog icon (Liquid Glass, dark, tinted), because
    /// that needs CFBundleIconName in Qobuz's Info.plist. Info.plist's hash is
    /// part of the executable's own signature, which macOS checks on every
    /// launch, so editing it stops Qobuz opening (once the cached check goes,
    /// e.g. after a restart). The custom icon sits outside what the signature
    /// covers. A custom icon that isn't Rosin's is left alone.
    private func installIcon(_ app: QobuzApp) throws {
        guard let source = Self.bundledIcon else { return }
        let data = try Data(contentsOf: source)
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let marker = Self.iconMarker(of: app)
        if marker == hash { return }
        if marker == nil, Self.hasCustomIcon(app) { return }

        guard let icon = NSImage(data: data), NSWorkspace.shared.setIcon(icon, forFile: app.url.path) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: app.url.path])
        }
        try Self.setIconMarker(hash, on: app)
        NSLog("[Rosin] Installed icon in \(app.name)")
    }

    /// Undoes installIcon, leaving Qobuz on its own icon.
    private func removeIcon(_ app: QobuzApp) throws {
        guard Self.iconMarker(of: app) != nil else { return }
        NSWorkspace.shared.setIcon(nil, forFile: app.url.path)
        try Self.setIconMarker(nil, on: app)
        NSLog("[Rosin] Removed icon from \(app.name)")
    }

    /// True if an earlier Rosin edited this Qobuz's Info.plist, which breaks
    /// its signature for good: removing the keys doesn't give back the exact
    /// file that was signed. Only reinstalling Qobuz fixes it.
    private static func hasBrokenSignature(_ app: QobuzApp) -> Bool {
        let info = NSDictionary(contentsOf: app.infoPlist)
        return info?[legacyIconKey] != nil
    }

    private static func hasCustomIcon(_ app: QobuzApp) -> Bool {
        FileManager.default.fileExists(atPath: app.url.appendingPathComponent("Icon\r").path)
    }

    private static func iconMarker(of app: QobuzApp) -> String? {
        let size = getxattr(app.url.path, iconMarker, nil, 0, 0, 0)
        guard size > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard getxattr(app.url.path, iconMarker, &buffer, size, 0, 0) == size else { return nil }
        return String(decoding: buffer, as: UTF8.self)
    }

    private static func setIconMarker(_ value: String?, on app: QobuzApp) throws {
        let result: Int32
        if let value {
            result = setxattr(app.url.path, iconMarker, value, value.utf8.count, 0, 0)
        } else {
            result = removexattr(app.url.path, iconMarker, 0)
            if result != 0, errno == ENOATTR { return }
        }
        if result != 0 { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    private static func describe(_ error: Error) -> String {
        let nsError = error as NSError
        let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError
        if nsError.code == NSFileWriteNoPermissionError || underlying?.code == Int(EPERM) {
            return permissionReason
        }
        return error.localizedDescription
    }

    // MARK: Relaunching

    /// Quits a running Qobuz app and opens it again, so it loads the patched app.html.
    ///
    /// The relaunch waits for the system's quit notification (see
    /// appLaunchedOrQuit). If Qobuz is still running after 10s, it's force-quit;
    /// if the notification was somehow missed, it's opened anyway. Either way a
    /// restart can't leave Qobuz closed for good.
    func restart(_ app: QobuzApp) {
        guard let running = app.runningInstance else {
            NSWorkspace.shared.openApplication(at: app.url, configuration: .init())
            return
        }
        pendingRelaunch.insert(app.bundleID)
        running.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, self.pendingRelaunch.contains(app.bundleID) else { return }
            if let running = app.runningInstance {
                running.forceTerminate()
            } else {
                self.pendingRelaunch.remove(app.bundleID)
                NSWorkspace.shared.openApplication(at: app.url, configuration: .init())
            }
        }
    }

    static func openAppManagementSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles")!
        NSWorkspace.shared.open(url)
    }
}
