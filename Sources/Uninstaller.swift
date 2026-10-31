import AppKit

/// Undoes everything Rosin has added to this Mac, then quits:
///
///   1. Removes the patch from each Qobuz app's app.html (Patcher.unpatchAll),
///      and the login item.
///   2. Reloads each open Qobuz, which re-reads the unpatched app.html, so its
///      styles and shortcuts go without a restart.
///   3. Deletes Application Support/Rosin (and the old QobuzShell folder),
///      Rosin's caches (Sparkle's downloads) and its UserDefaults.
///   4. Moves Rosin.app to the Trash (not in Debug, where it's a build product).
///
/// If the patch can't be removed, nothing else is touched: deleting loader.js
/// would leave Qobuz with a <script> that fails on every launch, and with Rosin
/// gone there'd be nothing to fix it.
enum Uninstaller {
    static func run(patcher: Patcher, bridge: QobuzBridge) {
        NSApp.activate()
        let confirm = NSAlert()
        confirm.messageText = "Uninstall Rosin?"
        confirm.informativeText = "This removes Rosin’s patch from Qobuz, reloads any open Qobuz window without Rosin’s styles, deletes Rosin’s settings, and moves Rosin to the Trash."
        confirm.addButton(withTitle: "Uninstall")
        confirm.addButton(withTitle: "Cancel")
        confirm.buttons[0].hasDestructiveAction = true
        guard confirm.runModal() == .alertFirstButtonReturn else { return }

        let failures = patcher.unpatchAll()
        guard failures.isEmpty else {
            showFailure(failures)
            return
        }
        LoginItem.setEnabled(false)

        bridge.callAll("reload")
        // The sends are asynchronous: give them a moment to reach the sockets
        // before their folder goes and Rosin quits.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            removeFiles()
            NSApp.terminate(nil)
        }
    }

    private static func showFailure(_ failures: [(app: QobuzApp, reason: String)]) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Rosin couldn’t remove its patch from Qobuz"
        alert.informativeText = failures.map { "\($0.app.name): \($0.reason)" }.joined(separator: "\n")
            + "\n\nNothing has been removed. Fix this, then try again."
        let needsPermission = failures.contains { $0.reason == Patcher.permissionReason }
        if needsPermission { alert.addButton(withTitle: "Open App Management Settings") }
        alert.addButton(withTitle: "OK")
        if alert.runModal() == .alertFirstButtonReturn, needsPermission {
            Patcher.openAppManagementSettings()
        }
    }

    private static func removeFiles() {
        let fm = FileManager.default
        let library = fm.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        var folders = [
            SupportFiles.directory,
            library.appendingPathComponent("Application Support/QobuzShell"),
        ]
        if let id = Bundle.main.bundleIdentifier {
            folders.append(library.appendingPathComponent("Caches/\(id)"))
            folders.append(library.appendingPathComponent("HTTPStorages/\(id)"))
            UserDefaults.standard.removePersistentDomain(forName: id)
        }
        for folder in folders where fm.fileExists(atPath: folder.path) {
            do {
                try fm.removeItem(at: folder)
            } catch {
                NSLog("[Rosin] Removing \(folder.path) failed: \(error.localizedDescription)")
            }
        }

        #if DEBUG
        NSLog("[Rosin] Debug build: not moving \(Bundle.main.bundleURL.path) to the Trash")
        #else
        do {
            try fm.trashItem(at: Bundle.main.bundleURL, resultingItemURL: nil)
        } catch {
            NSLog("[Rosin] Moving Rosin to the Trash failed: \(error.localizedDescription)")
        }
        #endif
    }
}
