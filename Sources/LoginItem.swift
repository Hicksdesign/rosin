import Foundation
import ServiceManagement

/// Launch at Login, via SMAppService (no helper app needed).
///
/// Rosin only re-patches Qobuz after an update while it's running, so this is
/// on by default: once, on the first launch of a Release build. Debug builds
/// leave it alone, so a build in DerivedData doesn't become a login item.
enum LoginItem {
    private static let defaultAppliedKey = "launchAtLoginDefaultApplied"

    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func setEnabled(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog("[Rosin] Launch at Login \(enabled ? "on" : "off") failed: \(error.localizedDescription)")
        }
        // Turned off in System Settings ▸ General ▸ Login Items: only the
        // person can turn it back on, so take them there.
        if enabled, SMAppService.mainApp.status == .requiresApproval {
            SMAppService.openSystemSettingsLoginItems()
        }
    }

    static func enableByDefault() {
        #if !DEBUG
        guard !UserDefaults.standard.bool(forKey: defaultAppliedKey) else { return }
        UserDefaults.standard.set(true, forKey: defaultAppliedKey)
        setEnabled(true)
        #endif
    }
}
