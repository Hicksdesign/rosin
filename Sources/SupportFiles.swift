import Foundation

/// The files the patched Qobuz app loads, all in
/// ~/Library/Application Support/Rosin/:
///
///   loader.js     copied from this app on every launch (the patch require()s it)
///   homepage.js   the Home page, copied likewise; loader.js require()s it
///   search.js     Better Search, copied and loaded likewise
///   config.json   where loader.js finds custom.css and the fonts, whether to apply them, the accent,
///                 and whether to show Home and use Better Search
///   sockets/      one Unix socket per running Qobuz app (created by loader.js)
///
/// custom.css and Fonts/ are looked up in this order (first match wins):
///   1. ~/Library/Application Support/Rosin/   — your own overrides, no rebuild needed
///   2. <project>/Resources/                          — Debug builds only, so edits apply live
///   3. The app bundle                                — what ships in the built app
enum SupportFiles {

    // MARK: Locations

    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Rosin", isDirectory: true)
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

    /// The accent colour picked in the menu, as "#rrggbb", or nil to use
    /// custom.css's. Only applies with the theme on.
    private static let accentKey = "accent"
    static var accent: String? {
        get { UserDefaults.standard.string(forKey: accentKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: accentKey)
            writeConfig()
        }
    }

    /// Whether loader.js adds the Home tab and page. On by default. Until
    /// November 2026 the page was called For You and this was saved as
    /// forYouEnabled, which is still read until the setting is next changed.
    private static let homePageEnabledKey = "homePageEnabled"
    private static let legacyHomePageEnabledKey = "forYouEnabled"
    static var homePageEnabled: Bool {
        get {
            let defaults = UserDefaults.standard
            return defaults.object(forKey: homePageEnabledKey) as? Bool
                ?? defaults.object(forKey: legacyHomePageEnabledKey) as? Bool
                ?? true
        }
        set {
            UserDefaults.standard.set(newValue, forKey: homePageEnabledKey)
            UserDefaults.standard.removeObject(forKey: legacyHomePageEnabledKey)
            writeConfig()
        }
    }

    /// Whether loader.js replaces Qobuz's search results with Better Search's
    /// as you type. On by default.
    private static let betterSearchEnabledKey = "betterSearchEnabled"
    static var betterSearchEnabled: Bool {
        get { UserDefaults.standard.object(forKey: betterSearchEnabledKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: betterSearchEnabledKey)
            writeConfig()
        }
    }

    // MARK: Install

    private struct Config: Encodable {
        var css: String?
        var fonts: String?
        var theme: Bool
        var accent: String?
        var homePage: Bool
        var betterSearch: Bool
    }

    /// The scripts copied into the support folder for Qobuz to load.
    private static let scripts = ["loader.js", "homepage.js", "search.js"]

    /// Scripts earlier versions copied there, deleted on install.
    /// foryou.js is homepage.js before the rename.
    private static let retiredScripts = ["foryou.js"]

    /// Copies the scripts and writes config.json. Run at launch and before
    /// reloading Qobuz, so the page always gets the current loader.
    static func install() {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: socketsDirectory, withIntermediateDirectories: true)

            // The scripts are code, not user overrides, so they aren't read from 1.
            for script in scripts {
                guard let source = firstExisting(script, in: [sourceResourcesDirectory, bundleDirectory]) else {
                    NSLog("[Rosin] \(script) not found")
                    continue
                }
                let destination = directory.appendingPathComponent(script)
                try? fm.removeItem(at: destination)
                try fm.copyItem(at: source, to: destination)
            }
            for script in retiredScripts {
                try? fm.removeItem(at: directory.appendingPathComponent(script))
            }

            writeConfig()
        } catch {
            NSLog("[Rosin] Installing support files failed: \(error.localizedDescription)")
        }
    }

    /// Writes config.json. loader.js reads it on load and on reloadStyles.
    static func writeConfig() {
        let dirs = [directory, sourceResourcesDirectory, bundleDirectory]
        let config = Config(
            css: firstExisting("custom.css", in: dirs)?.path,
            fonts: firstExisting("Fonts/fonts.json", in: dirs)?.deletingLastPathComponent().path,
            theme: themeEnabled,
            accent: accent,
            homePage: homePageEnabled,
            betterSearch: betterSearchEnabled
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        do {
            try encoder.encode(config).write(to: directory.appendingPathComponent("config.json"), options: .atomic)
        } catch {
            NSLog("[Rosin] Writing config.json failed: \(error.localizedDescription)")
        }
    }
}
