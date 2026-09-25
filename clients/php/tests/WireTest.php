<?php

declare(strict_types=1);

use Novamem\Config;
use Novamem\NovamemException;
use Novamem\Transport;
use Novamem\Types as T;
use PHPUnit\Framework\TestCase;

final class WireTest extends TestCase
{
    // proved by: encoding an empty map as array_map(...) instead of an
    // object fails this test (json_encode([]) is "[]").
    public function testAnEmptyMapIsSentAsAnObject(): void
    {
        $this->assertSame(
            '{"content":"c","metadata":{}}',
            json_encode(
                T\CaptureRequest::fromArray([
                    "content" => "c",
                    "metadata" => [],
                ])->toArray(),
            ),
        );
    }

    public function testRequiredNullableFieldsAreSentAsNull(): void
    {
        $this->assertSame(
            ["entries" => [], "nextAfterId" => null],
            (new T\ExportPage(entries: [], nextAfterId: null))->toArray(),
        );
    }

    public function testUnsetOptionalFieldsAreOmitted(): void
    {
        $this->assertSame(
            ["query" => "coffee"],
            (new T\SearchRequest(query: "coffee", namespace: ""))->toArray(),
        );
    }

    // proved by: returning strings unchanged from Wire::timestamp fails this test.
    public function testTimestampsAreSentAsUtcWithAZ(): void
    {
        $this->assertSame(
            ["since" => "2026-09-24T10:00:00.000Z"],
            (new T\RecentRequest(
                since: "2026-09-24T12:00:00+02:00",
            ))->toArray(),
        );
        $this->assertSame(
            ["since" => "yesterday-ish"],
            (new T\RecentRequest(since: "yesterday-ish"))->toArray(),
        );
    }

    public function testUnknownKeysAreIgnored(): void
    {
        $this->assertSame(
            ["content" => "c", "id" => "e1"],
            T\MemoryEntry::fromArray([
                "id" => "e1",
                "content" => "c",
                "future" => 1,
            ])->toArray(),
        );
    }

    /**
     * proved by: dropping the is_array / "{" check in Transport::decode
     * fails this test ([] would decode as an empty success).
     *
     * @return list<array{0: string}>
     */
    public static function nonObjectBodies(): array
    {
        return [["[]"], ["null"], ["1"], ['"ok"'], ['[{"id":"e1"}]']];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider("nonObjectBodies")]
    public function testANonObjectSuccessBodyIsMalformed(string $raw): void
    {
        $t = new Transport(new Config("http://127.0.0.1:1", "nm_x"));
        $decode = new \ReflectionMethod($t, "decode");
        try {
            $decode->invoke($t, "search", 200, $raw, true);
            $this->fail("accepted $raw");
        } catch (NovamemException $e) {
            $this->assertTrue($e->isUnavailable());
            $this->assertFalse($e->isRetryable());
            $this->assertStringContainsString("malformed", $e->getMessage());
        }
        $this->assertSame([], $decode->invoke($t, "search", 200, "{}", true));
    }
}
