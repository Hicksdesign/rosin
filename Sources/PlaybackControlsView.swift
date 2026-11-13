import AppKit

/// The playback row in the menu: previous, play/pause and next as icons,
/// spread across the menu's width. Clicking one doesn't close the menu, so
/// play/pause flips to show the new state and tracks can be skipped in turn.
final class PlaybackControlsView: NSView {
    enum Control: CaseIterable {
        case previous, playPause, next
    }

    private static let buttonSize = NSSize(width: 40, height: 28)
    /// Space between the menu's edges and the outer buttons' highlights, in
    /// line with the menu's own item highlights.
    private static let horizontalInset: CGFloat = 18
    private static let verticalPadding: CGFloat = 2
    private static let symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
    /// Previous and next are 20% smaller than play/pause, so it stands out.
    private static let skipSymbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)

    /// Shows pause while playing: the action a click will take, like the
    /// controls in Qobuz.
    var isPlaying = false { didSet { if isPlaying != oldValue { needsDisplay = true } } }
    var onControl: ((Control) -> Void)?

    private var hovered: Control? { didSet { if hovered != oldValue { needsDisplay = true } } }
    private var pressed: Control? { didSet { if pressed != oldValue { needsDisplay = true } } }

    init() {
        let width = Self.horizontalInset * 2 + Self.buttonSize.width * 3 + 60
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: Self.buttonSize.height + Self.verticalPadding * 2))
        autoresizingMask = .width
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }

    // MARK: Layout

    /// Justified: the first and last buttons at the edges, the middle one centred.
    private func rect(for control: Control) -> NSRect {
        let size = Self.buttonSize
        let index = CGFloat(Control.allCases.firstIndex(of: control)!)
        let span = bounds.width - Self.horizontalInset * 2 - size.width
        let x = Self.horizontalInset + span * index / CGFloat(Control.allCases.count - 1)
        return NSRect(x: x, y: Self.verticalPadding, width: size.width, height: size.height)
    }

    private func control(at point: NSPoint) -> Control? {
        Control.allCases.first { rect(for: $0).contains(point) }
    }

    private func image(for control: Control) -> NSImage? {
        let (symbol, description) = switch control {
        case .previous: ("backward.fill", "Previous Track")
        case .playPause: isPlaying ? ("pause.fill", "Pause") : ("play.fill", "Play")
        case .next: ("forward.fill", "Next Track")
        }
        return NSImage(systemSymbolName: symbol, accessibilityDescription: description)?
            .withSymbolConfiguration(control == .playPause ? Self.symbolConfiguration : Self.skipSymbolConfiguration)
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        for control in Control.allCases {
            let frame = rect(for: control)
            if control == hovered {
                let fill: NSColor = control == pressed ? .tertiaryLabelColor : .quaternaryLabelColor
                fill.setFill()
                NSBezierPath(roundedRect: frame, xRadius: 6, yRadius: 6).fill()
            }
            guard let image = image(for: control) else { continue }
            // Symbol images are templates: tint them to the label colour.
            let tinted = NSImage(size: image.size, flipped: false) { rect in
                image.draw(in: rect)
                NSColor.labelColor.set()
                rect.fill(using: .sourceAtop)
                return true
            }
            let origin = NSPoint(x: frame.midX - image.size.width / 2, y: frame.midY - image.size.height / 2)
            tinted.draw(in: NSRect(origin: origin, size: image.size))
        }
    }

    // MARK: Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
            owner: self, userInfo: nil
        ))
    }

    override func mouseMoved(with event: NSEvent) {
        hovered = control(at: convert(event.locationInWindow, from: nil))
    }

    override func mouseExited(with event: NSEvent) {
        hovered = nil
        pressed = nil
    }

    override func mouseDown(with event: NSEvent) {
        pressed = control(at: convert(event.locationInWindow, from: nil))
    }

    // As in AccentPickerView: act on mouseUp, as menu items do.
    override func mouseUp(with event: NSEvent) {
        pressed = nil
        guard let control = control(at: convert(event.locationInWindow, from: nil)) else { return }
        onControl?(control)
    }
}
