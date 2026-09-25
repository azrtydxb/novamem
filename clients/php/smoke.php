<?php

// Live round trip against a real server, for the sdk-smoke CI job.
//
//   NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… php smoke.php up|down
//
// up:   capture → search finds it → forget deletes it → search no longer finds it.
// down: the server has been stopped; search must report unavailable, not an
//       empty result. Every failure prints "php <step>: <detail>" and exits 1.

declare(strict_types=1);

require __DIR__ . "/vendor/autoload.php";

use Novamem\Client;
use Novamem\Config;
use Novamem\NovamemException;
use Novamem\Types as T;

function fail(string $step, string $detail): never
{
    echo "php $step: $detail\n";
    exit(1);
}

/** Runs one step; any error becomes "php <name>: <detail>". */
function step(string $name, callable $f): mixed
{
    try {
        return $f();
    } catch (\Throwable $e) {
        fail($name, $e->getMessage());
    }
}

$c = step(
    "connect",
    fn() => new Client(
        new Config(
            (string) getenv("NOVAMEM_SMOKE_URL"),
            (string) getenv("NOVAMEM_SMOKE_TOKEN"),
        ),
    ),
);

if (($argv[1] ?? "up") === "down") {
    try {
        $c->search(new T\SearchRequest(query: "anything"));
    } catch (NovamemException $e) {
        $e->isUnavailable() ||
            fail("down", "want unavailable, got " . $e->getMessage());
        echo "PASS php down\n";
        exit(0);
    }
    fail("down", "search succeeded against a stopped server");
}

$marker = bin2hex(random_bytes(12));
$query = new T\SearchRequest(query: $marker, namespace: "sdk-smoke");
$cap = step(
    "capture",
    fn() => $c->capture(
        new T\CaptureRequest(
            content: "sdk-smoke php $marker",
            namespace: "sdk-smoke",
            force: true,
        ),
    ),
);
($cap->id ?? "") !== "" || fail("capture", "not saved");
$hits = step("search", fn() => $c->search($query));
in_array($cap->id, array_map(fn($r) => $r->id, $hits->results), true) ||
    fail("search", "captured {$cap->id} not found");
$gone = step("forget", fn() => $c->forget(new T\ForgetRequest(id: $cap->id)));
$gone->deleted || fail("forget", "not deleted");
$after = step("search-after-forget", fn() => $c->search($query));
!in_array($cap->id, array_map(fn($r) => $r->id, $after->results), true) ||
    fail("search-after-forget", "{$cap->id} still returned");
echo "PASS php up\n";
