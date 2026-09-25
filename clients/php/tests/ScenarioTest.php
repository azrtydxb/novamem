<?php

// The shared behaviour suite (clients/contract/scenarios.json, ADR 0009).

declare(strict_types=1);

use Novamem\Admin;
use Novamem\Client;
use Novamem\Config;
use Novamem\Management;
use Novamem\NovamemException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ScenarioTest extends TestCase
{
    /** @var resource|null */
    private static $proc = null;
    private static string $url = "";
    private static string $closed = "";
    /** @var array<string, mixed> */
    private static array $scen = [];

    private static function contract(): string
    {
        return dirname(__DIR__, 2) . "/contract";
    }

    public static function setUpBeforeClass(): void
    {
        self::$scen = json_decode(
            (string) file_get_contents(self::contract() . "/scenarios.json"),
            true,
        );
        self::$proc = proc_open(
            ["sh", "scenario-server.sh", "-scenarios", "scenarios.json"],
            [1 => ["pipe", "w"]],
            $pipes,
            self::contract(),
        );
        [, self::$url, $closed] = explode(" ", trim((string) fgets($pipes[1])));
        self::$closed = explode("=", $closed)[1];
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$proc !== null) {
            proc_terminate(self::$proc, 9);
        }
    }

    /** @return array<string, array{string}> */
    public static function ids(): array
    {
        $s = json_decode(
            (string) file_get_contents(self::contract() . "/scenarios.json"),
            true,
        );
        $out = [];
        foreach ($s["scenarios"] as $x) {
            $out[$x["id"]] = [$x["id"]];
        }
        return $out;
    }

    private static function wire(mixed $r): mixed
    {
        return is_object($r) && method_exists($r, "toArray")
            ? $r->toArray()
            : $r;
    }

    private static function isEmptyResult(mixed $r): bool
    {
        $w = self::wire($r);
        return $w === [] ||
            (is_array($w) &&
                array_key_exists("results", $w) &&
                $w["results"] === []);
    }

    private static function subset(
        mixed $want,
        mixed $got,
        string $path = '$',
    ): string {
        if (is_array($want) && !array_is_list($want)) {
            if (!is_array($got)) {
                return "$path: want an object, got " . json_encode($got);
            }
            foreach ($want as $k => $v) {
                $d = self::subset($v, $got[$k] ?? null, "$path.$k");
                if ($d !== "") {
                    return $d;
                }
            }
            return "";
        }
        return $want === $got
            ? ""
            : "$path: got " .
                    json_encode($got) .
                    ", want " .
                    json_encode($want);
    }

    // proved by: removing the degraded-empty check in Client::search fails
    // search-degraded-empty-is-unavailable; removing the redaction fails
    // token-echoed-in-401-is-redacted.
    #[DataProvider("ids")]
    public function testScenarios(string $id): void
    {
        $s = null;
        foreach (self::$scen["scenarios"] as $x) {
            if ($x["id"] === $id) {
                $s = $x;
            }
        }
        if (in_array("cancel", $s["requires"] ?? [], true)) {
            $this->markTestSkipped(
                "the PHP client has no cancellation primitive: $id",
            );
        }
        $call = $s["call"];
        $token = self::$scen["token"];
        $r = null;
        $e = null;
        if ($call["class"] === "ctor") {
            try {
                new Client(
                    new Config(
                        str_replace(
                            "<server>",
                            self::$url,
                            $call["args"]["baseUrl"],
                        ),
                        $call["args"]["token"],
                    ),
                );
            } catch (\InvalidArgumentException $err) {
                $e = $err;
            }
        } else {
            $base = str_contains(
                (string) json_encode($s["respond"] ?? null),
                '"refused"',
            )
                ? "http://127.0.0.1:" . self::$closed . "/s/$id"
                : self::$url . "/s/$id";
            $cfg = new Config($base, $token, self::$scen["timeoutMs"]);
            $clients = [
                "Client" => new Client($cfg),
                "Management" => new Management($cfg),
                "Admin" => new Admin($cfg),
            ];
            try {
                $r = Dispatch::table()[$call["method"]](
                    $clients,
                    $call["args"],
                );
            } catch (NovamemException $err) {
                $e = $err;
            }
        }
        $outcome = match (true) {
            $e === null => self::isEmptyResult($r) ? "empty" : "ok",
            $e instanceof NovamemException && $e->isUnavailable()
                => "unavailable",
            $e instanceof NovamemException && $e->isNotFound() => "not_found",
            default => "error",
        };
        $exp = $s["expect"];
        $this->assertSame(
            $exp["outcome"],
            $outcome,
            "$id: " . ($e?->getMessage() ?? ""),
        );
        if ($e !== null) {
            $this->assertStringNotContainsString($token, (string) $e);
            // The exception's own fields, as the other SDKs check repr/inspect.
            // (print_r($e) would dump the whole trace, which holds PHPUnit's
            // test case and, with it, this scenario's token.)
            if ($e instanceof NovamemException) {
                $fields = [
                    $e->op(),
                    $e->statusCode(),
                    $e->errorCode(),
                    $e->detail(),
                    $e->getMessage(),
                ];
                $this->assertStringNotContainsString(
                    $token,
                    print_r($fields, true),
                );
            }
            if ($e instanceof NovamemException) {
                if (array_key_exists("retryable", $exp)) {
                    $this->assertSame($exp["retryable"], $e->isRetryable());
                }
                if (array_key_exists("statusCode", $exp)) {
                    $this->assertSame($exp["statusCode"], $e->statusCode());
                }
                if (array_key_exists("code", $exp)) {
                    $this->assertSame($exp["code"], $e->errorCode());
                }
            }
            if (array_key_exists("messageContains", $exp)) {
                $this->assertStringContainsStringIgnoringCase(
                    $exp["messageContains"],
                    $e->getMessage(),
                );
            }
        }
        if (array_key_exists("result", $exp)) {
            $this->assertSame("", self::subset($exp["result"], self::wire($r)));
        }
        if ($call["class"] !== "ctor") {
            $v = json_decode(
                (string) file_get_contents(self::$url . "/_verdict/$id"),
                true,
            );
            $this->assertSame([], $v["mismatches"]);
            if (($s["expectRequest"] ?? null) === []) {
                $this->assertSame(0, $v["requests"]);
            }
        }
    }
}
