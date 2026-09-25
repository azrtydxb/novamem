#!/bin/sh
# Prints the version an SDK's manifest declares, for the release
# workflows' version-matches-tag job:
#
#   sh scripts/sdk-version.sh <lang>
#
# PHP and Swift have no manifest version (Composer and SwiftPM take it
# from the mirror's tag), so they exit 3. An unknown language exits 2.
set -eu
cd "$(dirname "$0")/.."

first() { sed -n "$1" "$2" | head -n 1; }

case "${1:-}" in
python) first 's/^version = "\(.*\)"$/\1/p' clients/python/pyproject.toml ;;
typescript) first 's/^  "version": "\(.*\)",$/\1/p' clients/typescript/package.json ;;
dotnet) first 's/.*<Version>\(.*\)<\/Version>.*/\1/p' clients/dotnet/src/Novamem/Novamem.csproj ;;
java) first 's/^  <version>\(.*\)<\/version>$/\1/p' clients/java/pom.xml ;;
rust) first 's/^version = "\(.*\)"$/\1/p' clients/rust/Cargo.toml ;;
c) first 's/^version = "\(.*\)"$/\1/p' clients/c/novamem-ffi/Cargo.toml ;;
ruby) first 's/^  VERSION = "\(.*\)"$/\1/p' clients/ruby/lib/novamem/version.rb ;;
php | swift)
	echo "$1 has no manifest version: the mirror's tag is the version" >&2
	exit 3
	;;
*)
	echo "usage: sdk-version.sh <python|typescript|dotnet|java|rust|c|ruby>" >&2
	exit 2
	;;
esac
