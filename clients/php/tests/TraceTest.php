<?php

declare(strict_types=1);

use Novamem\Admin;
use Novamem\Client;
use Novamem\Config;
use Novamem\NovamemException;
use Novamem\Types as T;
use PHPUnit\Framework\TestCase;

/**
 * A failure must not carry a secret in its stack trace: print_r and
 * var_dump render every frame's arguments unless they are marked
 * #[\SensitiveParameter].
 */
final class TraceTest extends TestCase
{
    private const SECRET = "nm_trace_secret_must_not_leak";

    protected function setUp(): void
    {
        // Production php.ini drops trace arguments; development keeps them.
        ini_set("zend.exception_ignore_args", "0");
    }

    private static function refused(): Config
    {
        $s = stream_socket_server("tcp://127.0.0.1:0");
        $port = (int) explode(
            ":",
            (string) stream_socket_get_name($s, false),
        )[1];
        fclose($s);
        return new Config("http://127.0.0.1:$port", "nm_bearer");
    }

    private static function dump(\Throwable $e): string
    {
        ob_start();
        var_dump($e);
        return print_r($e, true) . ob_get_clean();
    }

    /** @param callable(): mixed $call */
    private function assertNoSecret(callable $call): void
    {
        try {
            $call();
            $this->fail("expected a transport failure");
        } catch (NovamemException $e) {
            $this->assertTrue($e->isUnavailable());
            $this->assertStringNotContainsString(self::SECRET, self::dump($e));
        }
    }

    // proved by: removing #[\SensitiveParameter] from Transport::call's
    // $body (or exchange/request's $payload) fails this test.
    public function testRevokeUserTokenKeepsTheTokenOutOfTheTrace(): void
    {
        $this->assertNoSecret(
            fn() => (new Admin(self::refused()))->revokeUserToken(self::SECRET),
        );
    }

    public function testProvisionUserKeepsThePasswordOutOfTheTrace(): void
    {
        $this->assertNoSecret(
            fn() => (new Admin(self::refused()))->provisionUser(
                new T\ProvisionUserRequest(
                    email: "a@example.com",
                    password: self::SECRET,
                ),
            ),
        );
    }

    public function testTheBearerStaysOutOfTheTrace(): void
    {
        $s = stream_socket_server("tcp://127.0.0.1:0");
        $port = (int) explode(
            ":",
            (string) stream_socket_get_name($s, false),
        )[1];
        fclose($s);
        $this->assertNoSecret(
            fn() => (new Client(
                new Config("http://127.0.0.1:$port", self::SECRET),
            ))->stats(),
        );
    }
}
