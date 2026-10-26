import Foundation

/// Finds and loads inject.js, custom.css and custom fonts.
///
/// Lookup order (first match wins):
///   1. ~/Library/Application Support/QobuzShell/   — your own overrides, no rebuild needed
///   2. <project>/Resources/                          — Debug builds only, so ⌘R / ⌘⇧R pick up edits live
///   3. The app bundle                                — what ships in the built app
///
/// inject.js is only read from 2 and 3 (it's code, not a user override).
enum UserStyles {

    // MARK: Locations

    static var overridesDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("QobuzShell", isDirectory: true)
    }

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

    // MARK: Scripts

    static func injectScript() -> String {
        guard let url = firstExisting("inject.js", in: [sourceResourcesDirectory, bundleDirectory]),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            NSLog("[QobuzShell] inject.js not found")
            return ""
        }
        return source
    }

    static func customCSS() -> String {
        let dirs = [overridesDirectory, sourceResourcesDirectory, bundleDirectory]
        guard let url = firstExisting("custom.css", in: dirs) else { return "" }
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }

    // MARK: Fonts

    /// One entry in Fonts/fonts.json.
    struct FontEntry: Codable {
        var family: String
        var file: String
        var weight: String?   // e.g. "400", or "100 900" for a variable font
        var style: String?    // "normal" or "italic"
    }

    /// What gets handed to the page: the font file itself, base64-encoded.
    private struct FontPayload: Encodable {
        var family: String
        var weight: String
        var style: String
        var data: String
    }

    /// Fonts are passed to the page as raw bytes and registered with the FontFace API.
    /// Because nothing is fetched from a URL, Qobuz's Content Security Policy
    /// (font-src) can't block them.
    private static func fontPayloads() -> [FontPayload] {
        let dirs = [overridesDirectory, sourceResourcesDirectory, bundleDirectory]
        guard let manifestURL = firstExisting("Fonts/fonts.json", in: dirs),
              let manifestData = try? Data(contentsOf: manifestURL),
              let entries = try? JSONDecoder().decode([FontEntry].self, from: manifestData) else {
            return []
        }
        let fontsDir = manifestURL.deletingLastPathComponent()
        return entries.compactMap { entry in
            let fileURL = fontsDir.appendingPathComponent(entry.file)
            guard let data = try? Data(contentsOf: fileURL) else {
                NSLog("[QobuzShell] Font file missing: \(fileURL.path)")
                return nil
            }
            return FontPayload(
                family: entry.family,
                weight: entry.weight ?? "normal",
                style: entry.style ?? "normal",
                data: data.base64EncodedString()
            )
        }
    }

    /// `"<css>", [fonts]` — the two arguments for QobuzShell.applyStyles(), as JS literals.
    static func stylesArgumentsJS() -> String {
        let encoder = JSONEncoder()
        let css = (try? encoder.encode(customCSS())).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        let fonts = (try? encoder.encode(fontPayloads())).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        return "\(css), \(fonts)"
    }
}
