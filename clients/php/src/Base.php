<?php

declare(strict_types=1);

namespace Novamem;

/** Shared by Client, Management and Admin. Safe to reuse across calls. */
abstract class Base
{
    protected readonly Transport $t;

    public function __construct(Config $config)
    {
        $this->t = new Transport($config);
    }

    protected static function seg(string $s): string
    {
        return rawurlencode($s);
    }

    protected static function blank(?string $s): bool
    {
        return trim((string) $s) === "";
    }

    /**
     * @param array<string, mixed> $a
     * @return array<string, mixed>
     */
    protected static function compact(array $a): array
    {
        return array_filter($a, fn($v) => $v !== null && $v !== "");
    }

    /**
     * A degraded answer with no results is an outage wearing the costume of
     * an empty result set. A degraded answer WITH results is real data.
     */
    protected static function degradedEmpty(string $op, mixed $body): void
    {
        if (
            is_array($body) &&
            ($body["degraded"] ?? false) &&
            ($body["results"] ?? []) === []
        ) {
            throw new NovamemException(
                $op,
                "store answered degraded with no results, so this is not evidence of absence",
                200,
                unavailable: true,
                retryable: true,
            );
        }
    }
}
