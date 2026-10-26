import AppKit
import WebKit

/// The main window: a single WKWebView pointed at the Qobuz web player.
final class BrowserWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation {
    static let homeURL = URL(string: "https://play.qobuz.com/")!

    /// Hosts that stay inside the app. Links anywhere else open in the default browser.
    private static let internalHostSuffixes = ["qobuz.com"]

    let webView: WKWebView
    let bridge: WebBridge
    private let dragView: TitlebarDragView

    /// Height of a standard title bar. The window hides its title bar and lets
    /// the page run underneath, so this strip is what custom.css pads around.
    private static let titlebarHeight =
        NSWindow.frameRect(forContentRect: .zero, styleMask: [.titled]).height

    init() {
        let bridge = WebBridge()
        bridge.titlebarHeight = Self.titlebarHeight  // before install, so it's in the user script

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()                 // persistent cookies, so you stay signed in
        config.mediaTypesRequiringUserActionForPlayback = []  // let the player resume without a click
        // Present as Safari so the site doesn't treat us as an unknown embedded browser.
        config.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15"
        bridge.install(into: config.userContentController)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true  // Safari ▸ Develop ▸ [your Mac] ▸ QobuzShell

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Qobuz"  // not shown, but still used by the Window menu and Mission Control
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 900, height: 600)
        window.isReleasedWhenClosed = false

        // The web view takes every click, including in the area a title bar
        // would cover, so an invisible strip on top restores window dragging.
        let container = NSView()
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        let dragView = TitlebarDragView(frame: NSRect(
            x: 0, y: container.bounds.height - Self.titlebarHeight,
            width: container.bounds.width, height: Self.titlebarHeight
        ))
        dragView.autoresizingMask = [.width, .minYMargin]
        container.addSubview(dragView, positioned: .above, relativeTo: webView)
        window.contentView = container
        window.center()
        window.setFrameAutosaveName("QobuzShellMainWindow")

        self.webView = webView
        self.bridge = bridge
        self.dragView = dragView
        super.init(window: window)

        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        bridge.webView = webView

        webView.load(URLRequest(url: Self.homeURL))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // MARK: Window

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)  // hide rather than close; audio keeps playing
        return false
    }

    // In full screen the traffic lights are hidden and the window can't be
    // dragged, so drop the strip and tell the page there's nothing to pad.
    func windowWillEnterFullScreen(_ notification: Notification) {
        dragView.isHidden = true
        bridge.titlebarHeight = 0
    }

    func windowWillExitFullScreen(_ notification: Notification) {
        dragView.isHidden = false
        bridge.titlebarHeight = Self.titlebarHeight
    }

    // MARK: Menu actions (wired up in MainMenu)

    @objc func goBack(_ sender: Any?) { webView.goBack() }
    @objc func goForward(_ sender: Any?) { webView.goForward() }
    @objc func goHome(_ sender: Any?) { webView.load(URLRequest(url: Self.homeURL)) }

    /// Re-reads inject.js and custom.css before reloading, so script edits
    /// show up without rebuilding (in Debug builds; see UserStyles).
    @objc func reloadPage(_ sender: Any?) {
        bridge.reinstallScripts()
        webView.reload()
    }

    /// Re-applies custom.css and fonts to the current page without a reload.
    @objc func reloadCustomStyles(_ sender: Any?) { bridge.reloadStyles() }

    @objc func openSearch(_ sender: Any?) { bridge.call("openSearch") }
    @objc func closeImmersive(_ sender: Any?) { bridge.call("closeImmersive") }
    @objc func togglePlayPause(_ sender: Any?) { bridge.call("togglePlay") }
    @objc func nextTrack(_ sender: Any?) { bridge.call("next") }
    @objc func previousTrack(_ sender: Any?) { bridge.call("previous") }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(goBack(_:)): return webView.canGoBack
        case #selector(goForward(_:)): return webView.canGoForward
        default: return true
        }
    }

    // MARK: Helpers

    fileprivate static func isInternal(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased() else { return true }  // about:blank, data:, etc.
        return internalHostSuffixes.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

// MARK: - Navigation

extension BrowserWindowController: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // Only user-clicked links to other sites go out to the browser. Redirects,
        // iframes and sign-in flows are allowed through so login keeps working.
        if navigationAction.navigationType == .linkActivated,
           navigationAction.targetFrame?.isMainFrame ?? true,
           let url = navigationAction.request.url,
           !Self.isInternal(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // WebKit's content process can be killed under memory pressure; recover quietly.
        webView.reload()
    }
}

// MARK: - New windows (target="_blank")

extension BrowserWindowController: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if Self.isInternal(url) {
            webView.load(navigationAction.request)  // keep Qobuz pages in the one window
        } else {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}

// MARK: - Title bar drag area

/// Stands in for the hidden title bar: dragging moves the window, and a
/// double-click does whatever System Settings ▸ Desktop & Dock says
/// ("Double-click a window's title bar to…").
private final class TitlebarDragView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)  // "Maximize", or unset
            }
        } else {
            window.performDrag(with: event)
        }
    }
}
