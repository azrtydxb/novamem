// Live round trip against a real server, for the sdk-smoke CI job.
//
//   NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… swift run novamem-smoke up|down
//
// up:   capture → search finds it → forget deletes it → search no longer finds it.
// down: the server has been stopped; search must report unavailable, not an
//       empty result. Every failure prints "swift <step>: <detail>" and exits 1.

import Foundation
import Novamem

func fail(_ step: String, _ detail: String) -> Never {
    print("swift \(step): \(detail)")
    exit(1)
}

func step<T>(_ name: String, _ call: () async throws -> T) async -> T {
    do { return try await call() } catch { fail(name, "\(error)") }
}

let env = ProcessInfo.processInfo.environment
let client = await step("connect") {
    try Client(Config(baseURL: env["NOVAMEM_SMOKE_URL"] ?? "", token: env["NOVAMEM_SMOKE_TOKEN"] ?? ""))
}

if CommandLine.arguments.dropFirst().first == "down" {
    do {
        _ = try await client.search(SearchRequest(query: "anything"))
        fail("down", "search succeeded against a stopped server")
    } catch let e as NovamemError where e.isUnavailable {
        print("PASS swift down")
        exit(0)
    } catch {
        fail("down", "want unavailable, got \(error)")
    }
}

let marker = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
let query = SearchRequest(namespace: "sdk-smoke", query: marker)
let cap = await step("capture") {
    try await client.capture(CaptureRequest(content: "sdk-smoke swift \(marker)", force: true, namespace: "sdk-smoke"))
}

guard let id = cap.id, !id.isEmpty else { fail("capture", "not saved") }
let hits = await step("search") { try await client.search(query) }
if !hits.results.contains(where: { $0.id == id }) {
    fail("search", "captured \(id) not found")
}

let gone = await step("forget") { try await client.forget(ForgetRequest(id: id)) }
if !gone.deleted {
    fail("forget", "not deleted")
}

let after = await step("search-after-forget") { try await client.search(query) }
if after.results.contains(where: { $0.id == id }) {
    fail("search-after-forget", "\(id) still returned")
}

print("PASS swift up")
