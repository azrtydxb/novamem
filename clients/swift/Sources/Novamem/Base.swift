import Foundation

/// Shared by Client, Management and Admin. Safe to share across tasks.
public class Base: @unchecked Sendable {
    let t: Transport

    /// Nothing is read from the environment.
    public init(_ config: Config) {
        t = Transport(config)
    }

    static func blank(_ s: String?) -> Bool {
        (s ?? "").trimmingCharacters(in: .whitespaces).isEmpty
    }

    static func seg(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
    }

    /// A request as JSON. A value JSON cannot hold fails here, locally.
    static func encode(_ op: String, _ v: some Encodable) throws -> Data {
        do {
            return try JSONEncoder().encode(v)
        } catch {
            throw NovamemError(op: op, message: "encode request: \(error)")
        }
    }

    /// An object of the given fields, leaving out unset and empty ones.
    static func fields(_ pairs: [(String, Any?)]) -> Data {
        var o: [String: Any] = [:]
        for (k, v) in pairs {
            if let v, !((v as? String)?.isEmpty ?? false) {
                o[k] = v
            }
        }
        return (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8)
    }

    static func object(_ o: [String: Any?]) -> Data {
        (try? JSONSerialization.data(withJSONObject: o.mapValues { $0 ?? NSNull() })) ?? Data("{}".utf8)
    }

    /// Decodes a successful body; one of the wrong shape keeps its status.
    static func decode<T: Decodable>(_ op: String, _ r: (status: Int, body: Data?)) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: r.body ?? Data())
        } catch {
            throw NovamemError(op: op, message: "malformed response body", statusCode: r.status, unavailable: true)
        }
    }

    /// A degraded answer with no results is an outage wearing the costume of
    /// an empty result set. A degraded answer WITH results is real data.
    static func degradedEmpty(_ op: String, _ r: (status: Int, body: Data?)) throws {
        guard let d = r.body, let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
        if (o["degraded"] as? Bool) == true, ((o["results"] as? [Any]) ?? []).isEmpty {
            throw NovamemError(op: op, message: "store answered degraded with no results, so this is not evidence of absence",
                               statusCode: 200, unavailable: true, retryable: true)
        }
    }
}
