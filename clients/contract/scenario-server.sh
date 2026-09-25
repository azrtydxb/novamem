#!/bin/sh
# Build the scenario server, then exec it, so the process an SDK runner
# starts IS the server: killing it stops the server. `go run` would leave
# its compiled child alive, holding the runner's stdout open after the kill.
set -eu
cd "$(dirname "$0")"
bin="${TMPDIR:-/tmp}/novamem-scenario-server-$$"
go build -o "$bin" ./cmd/scenario-server
exec "$bin" "$@"
