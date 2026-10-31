import AppKit
import Sparkle

/// Sparkle updates from the appcast at SUFeedURL (Info.plist, set in
/// project.yml). Automatic checks are on (SUEnableAutomaticChecks), so testers
/// aren't asked whether to check.
///
/// Rosin is menubar-only, so an update window from a scheduled check would
/// open behind other apps. Instead Sparkle waits ("gentle reminders") and the
/// menu shows Update Available… until it's dealt with.
final class Updater: NSObject, SPUStandardUserDriverDelegate {
    private var controller: SPUStandardUpdaterController?

    /// Set when a scheduled check finds an update, cleared when the session ends.
    private(set) var updateAvailable = false

    override init() {
        super.init()
        // Without a feed and key Sparkle can't verify anything (and complains
        // on every launch), so a build without them just has no updates.
        guard Self.isConfigured else {
            NSLog("[Rosin] Updates off: SUFeedURL or SUPublicEDKey is empty")
            return
        }
        controller = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: nil, userDriverDelegate: self
        )
    }

    var canCheckForUpdates: Bool { controller?.updater.canCheckForUpdates ?? false }

    func checkForUpdates() {
        // The update window needs Rosin in front to take clicks.
        NSApp.activate()
        controller?.checkForUpdates(nil)
    }

    private static var isConfigured: Bool {
        ["SUFeedURL", "SUPublicEDKey"].allSatisfy {
            (Bundle.main.object(forInfoDictionaryKey: $0) as? String)?.isEmpty == false
        }
    }

    // MARK: SPUStandardUserDriverDelegate

    var supportsGentleScheduledUpdateReminders: Bool { true }

    func standardUserDriverShouldHandleShowingScheduledUpdate(
        _ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool
    ) -> Bool {
        // Only show the window straight away if Rosin is already in front;
        // otherwise the menu item does it.
        immediateFocus
    }

    func standardUserDriverWillHandleShowingUpdate(
        _ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState
    ) {
        if !state.userInitiated { updateAvailable = true }
    }

    func standardUserDriverWillFinishUpdateSession() {
        updateAvailable = false
    }
}
