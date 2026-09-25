import Foundation

enum Wire {
    /// A timestamp sent as UTC with a Z. A string that does not parse is sent
    /// unchanged, and the server answers it.
    static func timestamp(_ s: String) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        guard let date = fractional.date(from: s) ?? plain.date(from: s) else { return s }
        return format(date)
    }

    static func format(_ date: Date) -> String {
        let out = ISO8601DateFormatter()
        out.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        out.timeZone = TimeZone(identifier: "UTC")
        return out.string(from: date)
    }
}
