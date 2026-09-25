# SDK T9: .NET SDK

Status: open
Created: 2026-09-25

## Description

Ship clients/dotnet (NuGet `Novamem` 0.1.0, no package references), held to the shared scenario suite (plan Task 9, spec S-6).

## Acceptance criteria

- [ ] `cd clients/dotnet && dotnet test` passes every TestScenarios theory and TestEveryRouteIsAccounted
- [ ] Removing token redaction fails `token-echoed-in-401-is-redacted` (mutation check, reverted)
- [ ] `dotnet list clients/dotnet/src/Novamem/Novamem.csproj package` reports no packages
- [ ] The smoke project exists, and the `dotnet` job is in sdk.yml

## Evidence
