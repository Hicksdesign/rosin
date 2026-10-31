import AppKit

/// The alerts at launch. Rosin has no window, so without them a new user sees
/// nothing happen, and the two things they may need to do (allow App
/// Management, restart Qobuz) are only in the menu.
///
///   - First launch: a welcome that says what happened. Patched, Qobuz
///     running → offer to restart it. Patched, Qobuz not running → all set. No
///     Qobuz, or app.html changed → say so.
///   - Any launch where macOS blocks the patch: ask for App Management, then
///     Try Again once it's on. Without the permission nothing works, so this
///     comes back each launch until it's granted.
///
/// Try Again is a button rather than a timer: retrying in the background while
/// the permission is off would make macOS show its "prevented from modifying
/// apps" notice on every attempt.
final class Onboarding {
    private static let welcomedKey = "didShowWelcome"
    private static let intro = "Rosin adds custom styles and shortcuts to the Qobuz app, shows what’s playing in the menubar, and keeps everything in place when Qobuz updates."

    private let patcher: Patcher

    init(patcher: Patcher) {
        self.patcher = patcher
    }

    func run() {
        let firstRun = !UserDefaults.standard.bool(forKey: Self.welcomedKey)
        UserDefaults.standard.set(true, forKey: Self.welcomedKey)
        if !patcher.appsNeedingPermission.isEmpty {
            askForPermission(welcome: firstRun)
        } else if firstRun {
            showResult(welcome: true)
        }
    }

    // MARK: App Management

    private func askForPermission(welcome: Bool) {
        let alert = NSAlert()
        alert.messageText = welcome ? "Welcome to Rosin" : "Rosin needs permission to modify Qobuz"
        alert.informativeText = (welcome ? Self.intro + "\n\n" : "")
            + "To do that, Rosin adds one line to a file inside the Qobuz app, which macOS only allows with your permission.\n\nIn System Settings, turn on Rosin under App Management, then come back and click Try Again."
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Later")
        guard run(alert) == .alertFirstButtonReturn else { return }
        Patcher.openAppManagementSettings()
        waitForPermission(stillBlocked: false)
    }

    private func waitForPermission(stillBlocked: Bool) {
        let alert = NSAlert()
        alert.messageText = "Turn on Rosin in App Management"
        alert.informativeText = stillBlocked
            ? "Rosin still can’t modify Qobuz. If Rosin is already turned on, quit Rosin and open it again."
            : "When Rosin is turned on in System Settings, click Try Again."
        alert.addButton(withTitle: "Try Again")
        alert.addButton(withTitle: "Later")
        guard run(alert) == .alertFirstButtonReturn else { return }
        patcher.patchAll()
        if patcher.appsNeedingPermission.isEmpty {
            showResult(welcome: false)
        } else {
            waitForPermission(stillBlocked: true)
        }
    }

    // MARK: Result

    private func showResult(welcome: Bool) {
        let alert = NSAlert()
        alert.messageText = welcome ? "Welcome to Rosin" : "Rosin is set up"
        var text = welcome ? Self.intro + "\n\n" : ""
        let failures = patcher.failures
        let needsRestart = patcher.apps.filter { patcher.patchedWhileRunning.contains($0.bundleID) }

        if patcher.apps.isEmpty {
            alert.alertStyle = .warning
            text += "Rosin can’t find the Qobuz app. Install it from qobuz.com and Rosin will set it up automatically."
        } else if !failures.isEmpty {
            alert.alertStyle = .warning
            text += "Rosin couldn’t set up "
                + failures.map { "\($0.app.name) (\($0.reason))" }.joined(separator: " or ") + "."
        } else if !needsRestart.isEmpty {
            text += Self.list(needsRestart.map(\.name))
                + (needsRestart.count > 1 ? " need" : " needs") + " to restart to load Rosin."
            alert.addButton(withTitle: "Restart Now")
            alert.addButton(withTitle: "Later")
        } else {
            text += "You’re all set. Rosin is in the menubar, showing the current track."
        }
        alert.informativeText = text

        if run(alert) == .alertFirstButtonReturn, failures.isEmpty {
            for app in needsRestart { patcher.restart(app) }
        }
    }

    // MARK: Helpers

    /// Rosin is menubar-only, so it has to come forward for the alert to show.
    private func run(_ alert: NSAlert) -> NSApplication.ModalResponse {
        NSApp.activate()
        return alert.runModal()
    }

    private static func list(_ names: [String]) -> String {
        names.count > 1 ? names.dropLast().joined(separator: ", ") + " and " + names.last! : names.first ?? ""
    }
}
