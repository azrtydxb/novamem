#!/bin/sh
# Compiles the README's Quickstart (its first ```java block, a complete
# `public class Quickstart`) against the SDK's classes and Jackson, so the
# README cannot drift from the API it documents.
#
#   sh clients/java/check-readme.sh
#
# Needs a JDK 17+ and Maven on the PATH (CI: the maven:3.9-eclipse-temurin
# images). The SDK is compiled first when target/classes or cp.txt is missing.
# proved by: misspelling a method in the quickstart fails javac.
set -eu
cd "$(dirname "$0")"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

awk 'f && /^```/ { exit } f { print } !f && $0 == "```java" { f = 1 }' README.md >"$tmp/Quickstart.java"
if [ ! -s "$tmp/Quickstart.java" ]; then
	echo "readme java: no \`\`\`java block in README.md" >&2
	exit 1
fi

if [ ! -d target/classes ] || [ ! -s cp.txt ]; then
	mvn -B -q compile dependency:build-classpath -Dmdep.outputFile=cp.txt
fi

if ! javac -d "$tmp" -cp "target/classes:$(cat cp.txt)" "$tmp/Quickstart.java"; then
	echo "readme java: quickstart does not compile" >&2
	exit 1
fi
echo "readme java: quickstart ok"
