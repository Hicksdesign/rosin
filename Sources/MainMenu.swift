import AppKit

/// Builds the app's menu bar. Every keyboard shortcut lives here, so this is
/// the one place to change them.
enum MainMenu {
    static func build(browser: BrowserWindowController) -> NSMenu {
        let main = NSMenu()
        main.addItem(submenu(appMenu()))
        main.addItem(submenu(editMenu()))
        main.addItem(submenu(viewMenu(browser)))
        main.addItem(submenu(historyMenu(browser)))
        main.addItem(submenu(controlsMenu(browser)))
        let window = windowMenu()
        main.addItem(submenu(window))
        NSApp.windowsMenu = window
        return main
    }

    // MARK: Menus

    private static func appMenu() -> NSMenu {
        let name = ProcessInfo.processInfo.processName
        let menu = NSMenu(title: name)
        menu.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Hide \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        menu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        menu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        return menu
    }

    /// Standard Edit menu. Without it, ⌘C/⌘V/⌘A don't work in the web view's
    /// text fields (including the sign-in form).
    private static func editMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        menu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        menu.addItem(item("Redo", Selector(("redo:")), "z", [.command, .shift]))
        menu.addItem(.separator())
        menu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        menu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        menu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        menu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        return menu
    }

    private static func viewMenu(_ b: BrowserWindowController) -> NSMenu {
        let menu = NSMenu(title: "View")
        menu.addItem(item("Search", #selector(BrowserWindowController.openSearch(_:)), "f", target: b))
        // Escape is taken by this menu item. The injected script closes the
        // immersive view if it's open, and otherwise passes Escape on to the
        // page so Qobuz's own Escape handling still works.
        menu.addItem(item("Close Immersive View", #selector(BrowserWindowController.closeImmersive(_:)), "\u{1b}", [], target: b))
        // A setting rather than an action: the checkmark shows whether it's on.
        menu.addItem(item("Open Immersive View on Play", #selector(BrowserWindowController.toggleOpenImmersiveOnPlay(_:)), "", target: b))
        menu.addItem(.separator())
        menu.addItem(item("Reload Page", #selector(BrowserWindowController.reloadPage(_:)), "r", target: b))
        menu.addItem(item("Reload Custom CSS", #selector(BrowserWindowController.reloadCustomStyles(_:)), "r", [.command, .shift], target: b))
        menu.addItem(.separator())
        menu.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        return menu
    }

    private static func historyMenu(_ b: BrowserWindowController) -> NSMenu {
        let menu = NSMenu(title: "History")
        menu.addItem(item("Back", #selector(BrowserWindowController.goBack(_:)), "[", target: b))
        menu.addItem(item("Forward", #selector(BrowserWindowController.goForward(_:)), "]", target: b))
        menu.addItem(.separator())
        menu.addItem(item("Home", #selector(BrowserWindowController.goHome(_:)), "h", [.command, .shift], target: b))
        return menu
    }

    private static func controlsMenu(_ b: BrowserWindowController) -> NSMenu {
        let menu = NSMenu(title: "Controls")
        // No shortcut on Play/Pause: Space is handled by the page itself, and a
        // menu shortcut would steal it from text fields.
        menu.addItem(item("Play/Pause", #selector(BrowserWindowController.togglePlayPause(_:)), "", target: b))
        menu.addItem(item("Next Track", #selector(BrowserWindowController.nextTrack(_:)), String(Character(UnicodeScalar(NSRightArrowFunctionKey)!)), target: b))
        menu.addItem(item("Previous Track", #selector(BrowserWindowController.previousTrack(_:)), String(Character(UnicodeScalar(NSLeftArrowFunctionKey)!)), target: b))
        return menu
    }

    private static func windowMenu() -> NSMenu {
        let menu = NSMenu(title: "Window")
        menu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        menu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        return menu
    }

    // MARK: Helpers

    private static func submenu(_ menu: NSMenu) -> NSMenuItem {
        let holder = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        return holder
    }

    private static func item(
        _ title: String,
        _ action: Selector,
        _ key: String,
        _ modifiers: NSEvent.ModifierFlags = [.command],
        target: AnyObject? = nil
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = target
        return item
    }
}
