import AppKit

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windowController: BrowserWindowController!
    private var statusItemController: StatusItemController!

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        windowController = BrowserWindowController()
        NSApp.mainMenu = MainMenu.build(browser: windowController)
        statusItemController = StatusItemController(
            bridge: windowController.bridge,
            showWindow: { [weak self] in self?.showMainWindow() }
        )
        showMainWindow()
    }

    // Closing the window only hides it, so playback carries on and the
    // menubar item keeps working. Quit with ⌘Q or from the menubar menu.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    // Clicking the Dock icon brings the hidden window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMainWindow() }
        return true
    }

    func showMainWindow() {
        windowController.showWindow(nil)
        windowController.window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }
}
