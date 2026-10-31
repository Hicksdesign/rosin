import AppKit

/// The accent colour row in the menu, like the tag colours in Finder's File
/// menu: a dot per colour, then one for any colour (the colour panel).
/// Clicking a dot doesn't close the menu, so colours can be tried in turn.
/// The first dot means no pick: custom.css's own accent. A caption under the
/// dots names the hovered one, or the current pick.
///
/// It belongs to Use Custom Theme, so it sits straight under that item, lined
/// up with its title, and dims when the theme is off.
final class AccentPickerView: NSView {
    /// Finder's tag colours (the system colours in the light appearance),
    /// fixed so the same hex goes to Qobuz in either appearance.
    static let palette: [(name: String, hex: String)] = [
        ("Red", "#FF3B30"),
        ("Orange", "#FF9500"),
        ("Yellow", "#FFCC00"),
        ("Green", "#28CD41"),
        ("Blue", "#007AFF"),
        ("Purple", "#AF52DE"),
        ("Grey", "#8E8E93"),
    ]

    private enum Swatch: Equatable {
        case themeDefault
        case colour(Int)
        case custom
    }

    private let swatches: [Swatch] = [.themeDefault] + palette.indices.map { .colour($0) } + [.custom]

    private static let diameter: CGFloat = 13
    /// From one dot's left edge to the next.
    private static let pitch: CGFloat = 21
    /// The ring around the current dot: its gap from the dot, and its width.
    private static let ringGap: CGFloat = 3.5
    private static let ringWidth: CGFloat = 1.5
    /// How far the ring reaches beyond the dot.
    private static let ringOutset = ringGap + ringWidth / 2
    /// Space above the rings and between them and the caption.
    private static let verticalPadding: CGFloat = 4
    private static let dotY = verticalPadding + ringOutset
    private static let captionY = dotY + diameter + ringOutset + verticalPadding
    private static let captionHeight: CGFloat = 16
    /// Where menu titles start, as measured on macOS 27; used until the real
    /// title has been found (see textInset).
    private static let defaultTextInset: CGFloat = 28

    /// The title of the menu item the dots line up with.
    let alignedTitle: String

    /// The current pick, as "#rrggbb", or nil for custom.css's.
    var accent: String? { didSet { needsDisplay = true } }
    var isEnabled = true {
        didSet { alphaValue = isEnabled ? 1 : 0.4; hovered = nil }
    }
    /// A dot was clicked: the new accent, or nil for custom.css's.
    var onPick: ((String?) -> Void)?
    /// The last dot was clicked.
    var onCustom: (() -> Void)?

    private var hovered: Swatch? { didSet { if hovered != oldValue { needsDisplay = true } } }

    init(alignedWith title: String) {
        alignedTitle = title
        let width = Self.defaultTextInset * 2 + Self.pitch * CGFloat(9)
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: Self.captionY + Self.captionHeight + Self.verticalPadding))
        autoresizingMask = .width
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }

    // MARK: Model

    private var selected: Swatch {
        guard let accent else { return .themeDefault }
        if let index = Self.palette.firstIndex(where: { $0.hex.caseInsensitiveCompare(accent) == .orderedSame }) {
            return .colour(index)
        }
        return .custom
    }

    private func name(of swatch: Swatch) -> String {
        switch swatch {
        case .themeDefault: return "Theme Default"
        case .colour(let index): return Self.palette[index].name
        case .custom: return selected == .custom ? "Custom" : "Custom…"
        }
    }

    // MARK: Layout

    /// The x where menu titles start. AppKit doesn't say, and it moves with
    /// the macOS version and whether items have images or checkmarks, so it's
    /// read from the aligned item's title field before drawing. (Not when the
    /// view joins the menu's window: the other rows aren't there yet.)
    private var textInset = AccentPickerView.defaultTextInset

    override func viewWillDraw() {
        super.viewWillDraw()
        guard let content = window?.contentView, let field = Self.textField(titled: alignedTitle, in: content) else { return }
        let x = field.convert(field.bounds, to: self).minX
        if x > 0 { textInset = x }
    }

    private static func textField(titled title: String, in view: NSView) -> NSTextField? {
        if let field = view as? NSTextField, field.stringValue == title { return field }
        for subview in view.subviews {
            if let field = textField(titled: title, in: subview) { return field }
        }
        return nil
    }

    private func rect(for index: Int) -> NSRect {
        let size = Self.diameter
        let x = textInset + Self.pitch * CGFloat(index)
        return NSRect(x: x, y: Self.dotY, width: size, height: size)
    }

    private func swatch(at point: NSPoint) -> Swatch? {
        swatches.indices.first { rect(for: $0).insetBy(dx: -4, dy: -4).contains(point) }.map { swatches[$0] }
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        for (index, swatch) in swatches.enumerated() {
            // Hovered dots grow, as in Finder; the current one gets a ring.
            var dot = rect(for: index)
            if swatch == hovered { dot = dot.insetBy(dx: -1.5, dy: -1.5) }
            draw(swatch, in: dot)
            if swatch == selected {
                let ring = NSBezierPath(ovalIn: rect(for: index).insetBy(dx: -Self.ringGap, dy: -Self.ringGap))
                ring.lineWidth = Self.ringWidth
                NSColor.labelColor.setStroke()
                ring.stroke()
            }
        }

        let caption = hovered.map(name(of:)) ?? "Accent: \(name(of: selected).replacingOccurrences(of: "…", with: ""))"
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        (caption as NSString).draw(at: NSPoint(x: textInset, y: Self.captionY), withAttributes: attributes)
    }

    private func draw(_ swatch: Swatch, in rect: NSRect) {
        let circle = NSBezierPath(ovalIn: rect)
        switch swatch {
        case .themeDefault:
            // An empty dot with a slash: no colour of its own.
            NSColor.secondaryLabelColor.setStroke()
            NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5)).stroke()
            let slash = NSBezierPath()
            slash.move(to: NSPoint(x: rect.minX + rect.width * 0.2, y: rect.maxY - rect.height * 0.2))
            slash.line(to: NSPoint(x: rect.maxX - rect.width * 0.2, y: rect.minY + rect.height * 0.2))
            slash.lineWidth = 1
            slash.stroke()
        case .colour(let index):
            NSColor(hex: Self.palette[index].hex)?.setFill()
            circle.fill()
        case .custom:
            // The custom colour once there is one, else a colour wheel.
            if selected == .custom, let accent, let colour = NSColor(hex: accent) {
                colour.setFill()
                circle.fill()
            } else {
                drawColourWheel(in: rect)
            }
        }
    }

    private func drawColourWheel(in rect: NSRect) {
        let centre = NSPoint(x: rect.midX, y: rect.midY)
        let segments = 36
        for segment in 0..<segments {
            let start = CGFloat(segment) / CGFloat(segments) * 360
            let wedge = NSBezierPath()
            wedge.move(to: centre)
            wedge.appendArc(withCenter: centre, radius: rect.width / 2, startAngle: start, endAngle: start + 360 / CGFloat(segments) + 0.5)
            wedge.close()
            NSColor(hue: CGFloat(segment) / CGFloat(segments), saturation: 0.85, brightness: 1, alpha: 1).setFill()
            wedge.fill()
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
        guard isEnabled else { return }
        hovered = swatch(at: convert(event.locationInWindow, from: nil))
    }

    override func mouseExited(with event: NSEvent) {
        hovered = nil
    }

    // Menus deliver mouseUp to item views; acting on it, as menu items do,
    // means a click that drifts off a dot does nothing.
    override func mouseUp(with event: NSEvent) {
        guard isEnabled, let swatch = swatch(at: convert(event.locationInWindow, from: nil)) else { return }
        switch swatch {
        case .themeDefault:
            accent = nil
            onPick?(nil)
        case .colour(let index):
            accent = Self.palette[index].hex
            onPick?(accent)
        case .custom:
            onCustom?()
        }
    }
}

extension NSColor {
    convenience init?(hex: String) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(
            srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    /// "#rrggbb" in sRGB, or nil for colours that don't convert (patterns).
    var hexString: String? {
        guard let rgb = usingColorSpace(.sRGB) else { return nil }
        let channels = [rgb.redComponent, rgb.greenComponent, rgb.blueComponent]
            .map { Int(($0.clamped * 255).rounded()) }
        return String(format: "#%02X%02X%02X", channels[0], channels[1], channels[2])
    }
}

private extension CGFloat {
    var clamped: CGFloat { Swift.min(Swift.max(self, 0), 1) }
}
