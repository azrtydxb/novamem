<?php

declare(strict_types=1);

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
            new T\ExportPage(entries: [], nextAfterId: null)->toArray(),
        );
    }

    public function testUnsetOptionalFieldsAreOmitted(): void
    {
        $this->assertSame(
            ["query" => "coffee"],
            new T\SearchRequest(query: "coffee", namespace: "")->toArray(),
        );
    }

    // proved by: returning strings unchanged from Wire::timestamp fails this test.
    public function testTimestampsAreSentAsUtcWithAZ(): void
    {
        $this->assertSame(
            ["since" => "2026-09-24T10:00:00.000Z"],
            new T\RecentRequest(since: "2026-09-24T12:00:00+02:00")->toArray(),
        );
        $this->assertSame(
            ["since" => "yesterday-ish"],
            new T\RecentRequest(since: "yesterday-ish")->toArray(),
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
}
