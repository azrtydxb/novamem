// Command scenario-server replays clients/contract/scenarios.json over
// HTTP for SDK test runners. It prints exactly one line on stdout,
//
//	listening http://127.0.0.1:<port> closed=<port>
//
// then serves until killed. closed is a port it bound and released at
// startup, for the "refused" fault: nothing listens there any more.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"

	"github.com/azrtydxb/novamem/clients/contract"
)

func main() {
	path := flag.String("scenarios", "scenarios.json", "scenario file")
	addr := flag.String("addr", "127.0.0.1:0", "listen address")
	flag.Parse()

	f, err := contract.LoadScenarios(*path)
	if err != nil {
		log.Fatal(err)
	}
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	closedPort := closed.Addr().(*net.TCPAddr).Port
	_ = closed.Close()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	// Runners block on this line; failing to write it must not leave them
	// waiting on a server that is up but silent.
	if _, err := fmt.Fprintf(os.Stdout, "listening http://%s closed=%d\n", ln.Addr(), closedPort); err != nil {
		log.Fatal(err)
	}
	_ = os.Stdout.Sync()
	srv := &http.Server{Handler: contract.NewServer(f)}
	log.Fatal(srv.Serve(ln))
}
