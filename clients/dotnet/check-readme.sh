#!/bin/sh
# Compiles the README's Quickstart (its first ```csharp block) as the
# Program.cs of a throwaway console project that references the SDK, so the
# README cannot drift from the API it documents.
#
#   sh clients/dotnet/check-readme.sh
#
# Needs the .NET 8 SDK on the PATH (CI: the mcr.microsoft.com/dotnet/sdk:8.0
# image). proved by: misspelling a method in the quickstart fails the build.
set -eu
cd "$(dirname "$0")"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

awk 'f && /^```/ { exit } f { print } !f && $0 == "```csharp" { f = 1 }' README.md >"$tmp/Program.cs"
if [ ! -s "$tmp/Program.cs" ]; then
	echo "readme dotnet: no \`\`\`csharp block in README.md" >&2
	exit 1
fi

cat >"$tmp/Readme.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="$PWD/src/Novamem/Novamem.csproj" />
  </ItemGroup>
</Project>
EOF

if ! out=$(dotnet build "$tmp/Readme.csproj" -nologo -v q 2>&1); then
	echo "$out" >&2
	echo "readme dotnet: quickstart does not compile" >&2
	exit 1
fi
echo "readme dotnet: quickstart ok"
