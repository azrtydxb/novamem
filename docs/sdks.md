---
title: SDKs
---

# SDKs

novamem has a client library for ten languages. Each one covers the same 41 operations — the data plane on `Client`, the caller's own tokens and projects on `Management`, server administration on `Admin` — and each is held to the same behaviour by one shared scenario suite ([`clients/contract`](https://github.com/azrtydxb/novamem/tree/main/clients/contract)), so an error means the same thing in every language.

Every SDK needs the Go novamem server (the first release after v1.1.7) and a bearer token (`nm_…`) minted from the dashboard's [API tokens](dashboard/tokens.md) page. The SDKs read no environment variables: the URL and token are passed in.

## The one rule every SDK keeps

An SDK never lets **"nothing is stored about that"** look like **"I could not reach the store"**. A refused connection, a timeout, a 5xx, a 429, a body that is not the JSON the API promises, and a search that came back degraded with no results all surface as _unavailable_ — never as an empty result. An empty result with no error is the only thing an SDK presents as "nothing is stored". No SDK retries on its own, every call is bounded by a timeout (15 s by default), and the token never appears in an error message.

Each SDK's README has its quickstart, this error contract in the language's own terms, and a table of all 41 operations.

## Go

```bash
go get github.com/azrtydxb/novamem/clients/go
```

The reference client. [README](https://github.com/azrtydxb/novamem/tree/main/clients/go#readme)

## Python

```bash
pip install novamem
```

Python 3.10+, standard library only; sync and asyncio clients. [README](https://github.com/azrtydxb/novamem/tree/main/clients/python#readme)

## TypeScript / JavaScript

```bash
npm install @azrtydxb/novamem
```

Node 20+, no runtime dependencies. Version 2.0.0 and later is this SDK; the 1.x releases of the package were the retired MCP shim. [README](https://github.com/azrtydxb/novamem/tree/main/clients/typescript#readme)

## .NET

```bash
dotnet add package Novamem
```

.NET 8+, no package references; every operation is `…Async` with a `CancellationToken`. [README](https://github.com/azrtydxb/novamem/tree/main/clients/dotnet#readme)

## Java

```xml
<dependency>
  <groupId>com.azrtydxb</groupId>
  <artifactId>novamem</artifactId>
  <version>0.1.0</version>
</dependency>
```

Java 17+, Jackson as the one dependency; every operation is blocking and `…Async` (`CompletableFuture`). [README](https://github.com/azrtydxb/novamem/tree/main/clients/java#readme)

## Rust

```bash
cargo add novamem
```

Async on tokio, rustls; MSRV 1.80. [README](https://github.com/azrtydxb/novamem/tree/main/clients/rust#readme)

## C and C++

A C ABI (`novamem.h`) and a header-only C++17 wrapper (`novamem.hpp`) over the Rust crate. Prebuilt archives for Linux x86_64 and aarch64 are attached to each `clients/c/v<version>` [GitHub release](https://github.com/azrtydxb/novamem/releases); a vcpkg port and a Conan recipe that install them live in [`clients/c/port`](https://github.com/azrtydxb/novamem/tree/main/clients/c/port). [README](https://github.com/azrtydxb/novamem/tree/main/clients/c#readme)

## Ruby

```bash
gem install novamem
```

Ruby 3.2+, standard library only. [README](https://github.com/azrtydxb/novamem/tree/main/clients/ruby#readme)

## PHP

```bash
composer require azrtydxb/novamem
```

PHP 8.2+ with `ext-curl` and `ext-json`, no other dependencies. Published from a read-only mirror of `clients/php`. [README](https://github.com/azrtydxb/novamem/tree/main/clients/php#readme)

## Swift

```swift
.package(url: "https://github.com/azrtydxb/novamem-swift", from: "0.1.0")
```

Swift 5.9+, Foundation only; `async` throughout. Published from a read-only mirror of `clients/swift`. [README](https://github.com/azrtydxb/novamem/tree/main/clients/swift#readme)

## Versions

Each SDK is versioned on its own: a release is a `clients/<language>/vX.Y.Z` tag, and publishing runs only after that SDK's whole test suite — and a live round trip against a server built from the same commit — has passed at the tag.
