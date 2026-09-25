<div align="center">

<img src="site/favicon.svg" alt="novamem" width="92" height="92" />

# novamem

**One memory across every AI agent you use.** Hybrid keyword + vector + graph + recency + entity retrieval (5-signal engine, graph/entity defaulted to 0 in production calibration). Per-user isolation with shareable sub-brains. Self-hostable on a laptop or as a multi-tenant brain for a whole company. Integrates with 30+ AI agent hosts.

### → [**azrtydxb.github.io/novamem**](https://azrtydxb.github.io/novamem/)

Full documentation, install paths, MCP host setup, architecture diagrams, API spec, and security model live on the project page above.

[![CI](https://github.com/azrtydxb/novamem/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/azrtydxb/novamem/actions/workflows/ci.yml)
[![Release](https://github.com/azrtydxb/novamem/actions/workflows/release-binaries.yml/badge.svg)](https://github.com/azrtydxb/novamem/actions/workflows/release-binaries.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<br />

<img src="site/dashboard.png" alt="novamem dashboard" width="100%" />

</div>

---

## SDKs

A client library per language, each covering the same 41 operations and held to one shared behaviour suite ([docs](https://azrtydxb.github.io/novamem/docs/sdks)).

| Language              | Package                                  | Install                                                                     | README                                   |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| Go                    | `github.com/azrtydxb/novamem/clients/go` | `go get github.com/azrtydxb/novamem/clients/go`                             | [clients/go](clients/go)                 |
| Python                | `novamem`                                | `pip install novamem`                                                       | [clients/python](clients/python)         |
| TypeScript/JavaScript | `@azrtydxb/novamem`                      | `npm install @azrtydxb/novamem`                                             | [clients/typescript](clients/typescript) |
| .NET                  | `Novamem`                                | `dotnet add package Novamem`                                                | [clients/dotnet](clients/dotnet)         |
| Java                  | `com.azrtydxb:novamem`                   | Maven / Gradle `com.azrtydxb:novamem:0.1.0`                                 | [clients/java](clients/java)             |
| Rust                  | `novamem`                                | `cargo add novamem`                                                         | [clients/rust](clients/rust)             |
| C / C++               | release archive, vcpkg, Conan            | `novamem-c-<version>-<triplet>.tar.gz` from the `clients/c/v*` release      | [clients/c](clients/c)                   |
| Ruby                  | `novamem`                                | `gem install novamem`                                                       | [clients/ruby](clients/ruby)             |
| PHP                   | `azrtydxb/novamem`                       | `composer require azrtydxb/novamem`                                         | [clients/php](clients/php)               |
| Swift                 | `novamem-swift`                          | `.package(url: "https://github.com/azrtydxb/novamem-swift", from: "0.1.0")` | [clients/swift](clients/swift)           |

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
