# SDK T9: .NET SDK

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Ship clients/dotnet (NuGet `Novamem` 0.1.0, no package references), held to the shared scenario suite (plan Task 9, spec S-6).

## Acceptance criteria

- [x] `cd clients/dotnet && dotnet test` passes every TestScenarios theory and TestEveryRouteIsAccounted
- [x] Removing the redaction, the degraded rule or the cross-origin guard each fails its scenario (mutation checks, reverted)
- [x] `dotnet list clients/dotnet/src/Novamem/Novamem.csproj package` reports no packages
- [x] The smoke project exists, and the `dotnet` job is in sdk.yml

## Evidence

- Local (.NET SDK 8.0.131, installed with the owner's approval so the gate can check C#): `dotnet test tests/Novamem.Tests` → `Passed! - Failed: 0, Passed: 84`. That's 83 scenarios (both cancel and both redirect scenarios included) plus TestEveryRouteIsAccounted.
- Mutation: disabling DegradedEmpty → `search-degraded-empty-is-unavailable` fails. Removing the redaction → both token-echoed scenarios fail. Keeping auth across origins → `redirect-cross-origin-drops-bearer` fails. All restored, and back to 84/84.
- `dotnet list src/Novamem/Novamem.csproj package` → `No packages were found for this framework.` The smoke project builds. The gate is clean (csharpier: 16 clean). `go run ./clients/gen -check` exits 0.
