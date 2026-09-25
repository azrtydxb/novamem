#!/bin/sh
# Build the scenario server, then exec it, so the process an SDK runner
# starts IS the server: killing it stops the server. `go run` would leave
# its compiled child alive, holding the runner's stdout open after the kill.
set -eu
cd "$(dirname "$0")"
bin="${TMPDIR:-/tmp}/novamem-scenario-server-$$"
# -buildvcs=false: in a CI container the checkout belongs to another user,
# git refuses to report its status, and a VCS-stamped build fails.
go build -buildvcs=false -o "$bin" ./cmd/scenario-server
exec "$bin" "$@"
