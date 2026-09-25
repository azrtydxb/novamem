import Foundation
import XCTest

final class RouteTests: XCTestCase {
    /// proved by: deleting a dispatch entry fails this test; renaming
    /// Client.sessionRecap fails compilation of the dispatch table.
    func testEveryRouteIsAccounted() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../contract/routes.json")
            .standardizedFileURL
        let routes = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: [String: Any]])
        for (key, r) in routes {
            for m in (r["methods"] as? [[String: Any]]) ?? [] {
                let name = try XCTUnwrap(m["name"] as? String)
                XCTAssertNotNil(dispatchTable[name], "\(key): no dispatch entry for \(name)")
            }
        }
    }
}
