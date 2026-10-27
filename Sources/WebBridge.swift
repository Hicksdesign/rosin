import Foundation
import WebKit

/// What the injected script reports about the current track.
struct NowPlaying: Equatable {
    var title = ""
    var artist = ""
    var album = ""
    var artworkURL: URL?
    var isPlaying = false
    /// "mediaSession" or "dom" — which source the metadata came from. Handy when debugging selectors.
    var source = ""

    var hasTrack: Bool { !title.isEmpty }
}

/// Two-way link between Swift and the page.
///  - Swift → page: `call("togglePlay")` runs `window.QobuzShell.togglePlay()`.
///  - Page → Swift: inject.js posts messages to the `qobuzShell` handler.
final class WebBridge: NSObject, WKScriptMessageHandler {
    static let nowPlayingDidChange = Notification.Name("QobuzShell.nowPlayingDidChange")
    private static let handlerName = "qobuzShell"

    weak var webView: WKWebView?
    private weak var contentController: WKUserContentController?

    private(set) var nowPlaying = NowPlaying() {
        didSet {
            guard nowPlaying != oldValue else { return }
            NotificationCenter.default.post(name: Self.nowPlayingDidChange, object: self)
        }
    }

    /// Height of the hidden title bar the page sits under, exposed to CSS as
    /// --qobuz-shell-titlebar-height. Set before the first load so it's in the
    /// user script; later changes (full screen) go straight to the page.
    var titlebarHeight: CGFloat = 0 {
        didSet {
            guard titlebarHeight != oldValue else { return }
            evaluate(titlebarHeightJS)
        }
    }

    private var titlebarHeightJS: String {
        "window.QobuzShell && QobuzShell.setTitlebarHeight(\(Int(titlebarHeight)));"
    }

    /// View ▸ Open Immersive View on Play. Saved in UserDefaults; included in the
    /// user script so it applies from the first load.
    private static let openImmersiveOnPlayKey = "openImmersiveOnPlay"
    var opensImmersiveOnPlay = UserDefaults.standard.bool(forKey: openImmersiveOnPlayKey) {
        didSet {
            UserDefaults.standard.set(opensImmersiveOnPlay, forKey: Self.openImmersiveOnPlayKey)
            evaluate(opensImmersiveOnPlayJS)
        }
    }

    private var opensImmersiveOnPlayJS: String {
        "window.QobuzShell && QobuzShell.setOpenImmersiveOnPlay(\(opensImmersiveOnPlay));"
    }

    // MARK: Setup

    func install(into controller: WKUserContentController) {
        contentController = controller
        // Note: WKUserContentController retains its handlers. That's fine here because
        // the bridge lives for the whole app session.
        controller.add(self, name: Self.handlerName)
        addUserScript(to: controller)
    }

    /// Swap in fresh copies of inject.js / custom.css / fonts for the next page load.
    func reinstallScripts() {
        guard let controller = contentController else { return }
        controller.removeAllUserScripts()
        addUserScript(to: controller)
    }

    /// Re-apply styles and fonts to the page that's already loaded.
    func reloadStyles() {
        reinstallScripts()
        evaluate("window.QobuzShell && QobuzShell.applyStyles(\(UserStyles.stylesArgumentsJS()));")
    }

    private func addUserScript(to controller: WKUserContentController) {
        // inject.js runs at document start so it can wrap mediaSession and
        // HTMLMediaElement before Qobuz's own code touches them. The styles and
        // title bar calls are appended so they always run after QobuzShell exists.
        let source = UserStyles.injectScript()
            + "\nwindow.QobuzShell && QobuzShell.applyStyles(\(UserStyles.stylesArgumentsJS()));"
            + "\n" + titlebarHeightJS
            + "\n" + opensImmersiveOnPlayJS
        controller.addUserScript(WKUserScript(
            source: source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
    }

    // MARK: Swift → page

    /// Calls a command exposed on `window.QobuzShell` (see inject.js).
    func call(_ command: String) {
        evaluate("window.QobuzShell && QobuzShell.\(command)();")
    }

    private func evaluate(_ js: String) {
        webView?.evaluateJavaScript(js) { _, error in
            if let error { NSLog("[QobuzShell] JS error: \(error.localizedDescription)") }
        }
    }

    // MARK: Page → Swift

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }

        switch type {
        case "nowPlaying":
            let artwork = (body["artwork"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
            nowPlaying = NowPlaying(
                title: body["title"] as? String ?? "",
                artist: body["artist"] as? String ?? "",
                album: body["album"] as? String ?? "",
                artworkURL: artwork,
                isPlaying: body["playing"] as? Bool ?? false,
                source: body["source"] as? String ?? ""
            )
        case "log":
            NSLog("[QobuzShell/page] \(body["message"] as? String ?? "")")
        default:
            break
        }
    }
}
