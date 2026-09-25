<?php

declare(strict_types=1);

use Novamem\Client;
use Novamem\Config;
use PHPUnit\Framework\TestCase;

/** A redirect must never carry the bearer to another origin. */
final class RedirectTest extends TestCase
{
    /** @var list<resource> */
    private array $procs = [];

    protected function tearDown(): void
    {
        foreach ($this->procs as $p) {
            proc_terminate($p, 9);
        }
    }

    private static function freePort(): int
    {
        $s = stream_socket_server("tcp://127.0.0.1:0");
        $port = (int) explode(
            ":",
            (string) stream_socket_get_name($s, false),
        )[1];
        fclose($s);
        return $port;
    }

    /** @param array<string, string> $env */
    private function serve(int $port, array $env): void
    {
        $this->procs[] = proc_open(
            [
                PHP_BINARY,
                "-S",
                "127.0.0.1:$port",
                __DIR__ . "/redirect_router.php",
            ],
            [1 => ["file", "/dev/null", "w"], 2 => ["file", "/dev/null", "w"]],
            $pipes,
            null,
            $env + getenv(),
        );
        for (
            $i = 0;
            $i < 50 && @fsockopen("127.0.0.1", $port) === false;
            $i++
        ) {
            usleep(100_000);
        }
    }

    // proved by: keeping $auth true across origins in Transport::exchange
    // fails this test.
    public function testACrossOriginRedirectDropsTheBearer(): void
    {
        $seen = tempnam(sys_get_temp_dir(), "nm");
        [$origin, $target] = [self::freePort(), self::freePort()];
        $this->serve($target, ["SEEN_FILE" => $seen, "REDIRECT_TO" => ""]);
        // 127.0.0.1 vs localhost: a different origin for the same host.
        $this->serve($origin, [
            "REDIRECT_TO" => "http://localhost:$target/moved",
        ]);
        $this->assertTrue(
            new Client(
                new Config("http://127.0.0.1:$origin", "nm_secret"),
            )->health(),
        );
        $this->assertSame(
            "none",
            file_get_contents($seen),
            "the bearer followed a redirect to another origin",
        );
    }

    public function testAnotherPortIsAnotherOrigin(): void
    {
        $seen = tempnam(sys_get_temp_dir(), "nm");
        [$origin, $target] = [self::freePort(), self::freePort()];
        $this->serve($target, ["SEEN_FILE" => $seen, "REDIRECT_TO" => ""]);
        $this->serve($origin, [
            "REDIRECT_TO" => "http://127.0.0.1:$target/moved",
        ]);
        $this->assertTrue(
            new Client(
                new Config("http://127.0.0.1:$origin", "nm_secret"),
            )->health(),
        );
        $this->assertSame("none", file_get_contents($seen));
    }

    public function testASameOriginRedirectKeepsTheBearer(): void
    {
        $seen = tempnam(sys_get_temp_dir(), "nm");
        $port = self::freePort();
        // /health redirects to /moved on the same server, which records.
        $this->serve($port, ["SEEN_FILE" => $seen, "REDIRECT_TO" => "/moved"]);
        $this->assertTrue(
            new Client(
                new Config("http://127.0.0.1:$port", "nm_secret"),
            )->health(),
        );
        $this->assertSame("Bearer nm_secret", file_get_contents($seen));
    }
}
