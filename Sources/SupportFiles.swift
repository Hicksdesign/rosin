import Foundation

/// The files the patched Qobuz app loads, all in
/// ~/Library/Application Support/QobuzShell/:
///
///   loader.js     copied from this app on every launch (the patch require()s it)
///   config.json   where loader.js finds custom.css and the fonts, and whether to apply them
///   sockets/      one Unix socket per running Qobuz app (created by loader.js)
///
/// custom.css and Fonts/ are looked up in this order (first match wins):
///   1. ~/Library/Application Support/QobuzShell/   — your own overrides, no rebuild needed
///   2. <project>/Resources/                          — Debug builds only, so edits apply live
///   3. The app bundle                                — what ships in the built app
enum SupportFiles {

    // MARK: Locations

    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("QobuzShell", isDirectory: true)
    }

    static var socketsDirectory: URL { directory.appendingPathComponent("sockets", isDirectory: true) }

    /// The Resources folder in the source tree. Works because the app isn't sandboxed.
    private static var sourceResourcesDirectory: URL? {
        #if DEBUG
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // Sources/
            .deletingLastPathComponent()      // project root
            .appendingPathComponent("Resources", isDirectory: true)
        #else
        return nil
        #endif
    }

    private static var bundleDirectory: URL? { Bundle.main.resourceURL }

    private static func firstExisting(_ relativePath: String, in directories: [URL?]) -> URL? {
        directories.compactMap { $0?.appendingPathComponent(relativePath) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    // MARK: Settings

    /// Whether loader.js applies custom.css and the fonts. On by default.
    /// Passed in config.json, so Qobuz starts with the right look.
    private static let themeEnabledKey = "themeEnabled"
    static var themeEnabled: Bool {
        get { UserDefaults.standard.object(forKey: themeEnabledKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: themeEnabledKey)
            writeConfig()
        }
    }

    // MARK: Install

    private struct Config: Encodable {
        var css: String?
        var fonts: String?
        var theme: Bool
    }

    /// Copies loader.js and writes config.json. Run at launch and before
    /// reloading Qobuz, so the page always gets the current loader.
    static func install() {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: socketsDirectory, withIntermediateDirectories: true)

            // loader.js is code, not a user override, so it isn't read from 1.
            guard let loader = firstExisting("loader.js", in: [sourceResourcesDirectory, bundleDirectory]) else {
                NSLog("[QobuzShell] loader.js not found")
                return
            }
            let loaderDestination = directory.appendingPathComponent("loader.js")
            try? fm.removeItem(at: loaderDestination)
            try fm.copyItem(at: loader, to: loaderDestination)

            writeConfig()
        } catch {
            NSLog("[QobuzShell] Installing support files failed: \(error.localizedDescription)")
        }
    }

    /// Writes config.json. loader.js reads it on load and on reloadStyles.
    static func writeConfig() {
        let dirs = [directory, sourceResourcesDirectory, bundleDirectory]
        let config = Config(
            css: firstExisting("custom.css", in: dirs)?.path,
            fonts: firstExisting("Fonts/fonts.json", in: dirs)?.deletingLastPathComponent().path,
            theme: themeEnabled
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        do {
            try encoder.encode(config).write(to: directory.appendingPathComponent("config.json"), options: .atomic)
        } catch {
            NSLog("[QobuzShell] Writing config.json failed: \(error.localizedDescription)")
        }
    }
}
