import AppKit

/// A menubar-only companion to the Qobuz desktop app. It patches Qobuz to load
/// loader.js (custom CSS, fonts, shortcuts, state reporting), keeps that patch
/// in place across Qobuz updates, and shows the current track in the menubar.
@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var patcher: Patcher!
    private var bridge: QobuzBridge!
    private var updater: Updater!
    private var statusItemController: StatusItemController!
    private var mediaKeys: MediaKeys!
    private var onboarding: Onboarding!

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        // No Dock icon or main menu; LSUIElement in Info.plist does the same
        // for the launch itself.
        app.setActivationPolicy(.accessory)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        SupportFiles.install()
        patcher = Patcher()
        bridge = QobuzBridge()
        updater = Updater()
        statusItemController = StatusItemController(bridge: bridge, patcher: patcher, updater: updater)
        mediaKeys = MediaKeys(bridge: bridge)
        LoginItem.enableByDefault()
        // After launch finishes, so the menubar item is already showing.
        onboarding = Onboarding(patcher: patcher)
        DispatchQueue.main.async { self.onboarding.run() }
    }
}
