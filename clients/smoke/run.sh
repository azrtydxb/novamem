#!/bin/sh
# One phase of one SDK's live smoke, for the sdk-smoke CI job:
#
#   sh clients/smoke/run.sh <lang> build   prepare the SDK (before the server starts)
#   sh clients/smoke/run.sh <lang> up      capture → search → forget → search, live
#   sh clients/smoke/run.sh <lang> down    the server is stopped: search must be unavailable
#
# up and down read NOVAMEM_SMOKE_URL and NOVAMEM_SMOKE_TOKEN, and never
# build: down measures the stopped server, not a compile. Run from the
# repository root. An unknown language or phase exits 2.
set -eu

lang=${1:-}
phase=${2:-}

build() {
	case "$lang" in
	python | ruby) ;;
	typescript) (cd clients/typescript && npm ci && npm run build) ;;
	dotnet) dotnet build clients/dotnet/smoke ;;
	java) (cd clients/java && mvn -B -q test-compile dependency:build-classpath -Dmdep.outputFile=cp.txt) ;;
	rust) cargo build --manifest-path clients/rust/Cargo.toml --example smoke ;;
	c) make -C clients/c build/smoke ;;
	php) (cd clients/php && composer install --no-dev --no-interaction --no-progress) ;;
	swift) swift build --package-path clients/swift --product novamem-smoke ;;
	*) return 2 ;;
	esac
}

smoke() {
	case "$lang" in
	python) python3 clients/python/smoke.py "$phase" ;;
	typescript) node clients/typescript/smoke.mjs "$phase" ;;
	dotnet) dotnet run --no-build --project clients/dotnet/smoke -- "$phase" ;;
	java) java -cp "$(cat clients/java/cp.txt):clients/java/target/classes:clients/java/target/test-classes" \
		com.azrtydxb.novamem.Smoke "$phase" ;;
	rust) target/debug/examples/smoke "$phase" ;;
	c) clients/c/build/smoke "$phase" ;;
	ruby) ruby -Iclients/ruby/lib clients/ruby/smoke.rb "$phase" ;;
	php) php clients/php/smoke.php "$phase" ;;
	swift) clients/swift/.build/debug/novamem-smoke "$phase" ;;
	*) return 2 ;;
	esac
}

case "$phase" in
build) build ;;
up | down) smoke ;;
*)
	echo "usage: run.sh <lang> <build|up|down>" >&2
	exit 2
	;;
esac
