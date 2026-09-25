// The shared behaviour suite (clients/contract/scenarios.json, ADR 0009).

import Foundation
@testable import Novamem
import XCTest
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

final class ScenarioTests: XCTestCase {
    static let contract = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../../contract").standardizedFileURL

    func startServer() throws -> (Process, String, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["scenario-server.sh", "-scenarios", "scenarios.json"]
        p.currentDirectoryURL = Self.contract
        let pipe = Pipe()
        p.standardOutput = pipe
        try p.run()
        var line = Data()
        while true {
            let b = pipe.fileHandleForReading.readData(ofLength: 1)
            if b.isEmpty || b == Data([0x0A]) {
                break
            }
            line.append(b)
        }
        let parts = String(decoding: line, as: UTF8.self).split(separator: " ").map(String.init)
        return (p, parts[1], String(parts[2].split(separator: "=")[1]))
    }

    func isEmpty(_ d: Data) -> Bool {
        let o = try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
        if let a = o as? [Any] {
            return a.isEmpty
        }
        if let m = o as? [String: Any], let r = m["results"] as? [Any] {
            return r.isEmpty
        }
        return false
    }

    func subset(_ want: Any, _ got: Any?, _ path: String = "$") -> String {
        if let w = want as? [String: Any] {
            guard let g = got as? [String: Any] else { return "\(path): want an object, got \(String(describing: got))" }
            for (k, v) in w {
                let d = subset(v, g[k], "\(path).\(k)")
                if !d.isEmpty {
                    return d
                }
            }
            return ""
        }
        return (want as? NSObject)?.isEqual(got) == true ? "" : "\(path): got \(String(describing: got)), want \(want)"
    }

    /// proved by: removing the degraded-empty check in Client.search fails
    /// search-degraded-empty-is-unavailable; removing the redaction fails
    /// token-echoed-in-401-is-redacted.
    func testScenarios() async throws {
        let scen = try XCTUnwrap(try JSONSerialization
            .jsonObject(with: Data(contentsOf: Self.contract.appendingPathComponent("scenarios.json"))) as? [String: Any])
        let token = try XCTUnwrap(scen["token"] as? String)
        let timeout = try Double(XCTUnwrap(scen["timeoutMs"] as? Int)) / 1000
        let (proc, url, closed) = try startServer()
        defer { proc.terminate() }
        var failures: [String] = []

        for s in try XCTUnwrap(scen["scenarios"] as? [[String: Any]]) {
            let id = try XCTUnwrap(s["id"] as? String)
            let call = try XCTUnwrap(s["call"] as? [String: Any])
            var result: Data?
            var err: Error?
            if call["class"] as! String == "ctor" {
                let a = try XCTUnwrap(call["args"] as? [String: String])
                do { _ = try Client(Config(
                    baseURL: XCTUnwrap(a["baseUrl"]?.replacingOccurrences(of: "<server>", with: url)),
                    token: XCTUnwrap(a["token"])
                )) } catch { err = error }
            } else {
                let respond = try String(
                    decoding: JSONSerialization.data(withJSONObject: s["respond"] ?? [:], options: [.fragmentsAllowed]),
                    as: UTF8.self
                )
                let base = respond.contains("\"refused\"") ? "http://127.0.0.1:\(closed)/s/\(id)" : "\(url)/s/\(id)"
                let cfg = try Config(baseURL: base, token: token, timeout: timeout)
                let c = Clients(client: Client(cfg), management: Management(cfg), admin: Admin(cfg))
                let args = try JSONSerialization.data(withJSONObject: call["args"] ?? [:])
                guard let fn = try dispatchTable[XCTUnwrap(call["method"] as? String)]
                else { failures.append("\(id): no dispatch entry"); continue }
                let task = Task { try await fn(c, args) }
                if let ms = call["cancelAfterMs"] as? Int {
                    Task { try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000); task.cancel() }
                }
                do { result = try await task.value } catch { err = error }
            }
            let outcome: String = switch err {
            case nil: isEmpty(result ?? Data()) ? "empty" : "ok"
            case is CancellationError: "canceled"
            case let e as NovamemError where e.isUnavailable: "unavailable"
            case let e as NovamemError where e.isNotFound: "not_found"
            default: "error"
            }
            let exp = try XCTUnwrap(s["expect"] as? [String: Any])
            if outcome !=
                exp["outcome"] as! String
            {
                failures.append("\(id): outcome \(outcome) (\(String(describing: err))), want \(exp["outcome"]!)")
            }
            if let e = err {
                if "\(e)".contains(token) || String(reflecting: e).contains(token) {
                    failures.append("\(id): token leaked")
                }
                if let ne = e as? NovamemError {
                    if let r = exp["retryable"] as? Bool, r != ne.isRetryable {
                        failures.append("\(id): retryable \(ne.isRetryable)")
                    }
                    if let sc = exp["statusCode"] as? Int, sc != ne.statusCode {
                        failures.append("\(id): status \(ne.statusCode)")
                    }
                    if let code = exp["code"] as? String, code != ne.code {
                        failures.append("\(id): code \(ne.code)")
                    }
                }
                if let m = exp["messageContains"] as? String,
                   !"\(e)".lowercased().contains(m.lowercased())
                {
                    failures.append("\(id): message \(e)")
                }
            }
            if let want = exp["result"] {
                let got = result.flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) }
                let d = subset(want, got)
                if !d.isEmpty {
                    failures.append("\(id): result \(d)")
                }
            }
            if try XCTUnwrap(call["class"] as? String) != "ctor" {
                let (vd, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: "\(url)/_verdict/\(id)")))
                let v = try XCTUnwrap(try JSONSerialization.jsonObject(with: vd) as? [String: Any])
                if try !XCTUnwrap((v["mismatches"] as? [Any])?.isEmpty) {
                    failures.append("\(id): mismatches \(v["mismatches"]!)")
                }
                if let er = s["expectRequest"] as? [Any], er.isEmpty,
                   try XCTUnwrap(v["requests"] as? Int) != 0
                {
                    failures.append("\(id): expected no request")
                }
            }
        }
        XCTAssert(failures.isEmpty, "\(failures.count) failure(s):\n" + failures.joined(separator: "\n"))
    }
}
