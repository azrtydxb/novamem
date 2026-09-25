<?php

declare(strict_types=1);

namespace Novamem;

/**
 * Everything a client needs, all of it injected: nothing is read from the
 * environment. Construction fails on a missing or unusable setting, naming
 * the field and never quoting the value.
 */
final class Config
{
    public const DEFAULT_TIMEOUT_MS = 15000;

    public readonly string $baseUrl;
    public readonly int $timeoutMs;
    private readonly string $token;

    public function __construct(
        string $baseUrl,
        #[\SensitiveParameter] string $token,
        int $timeoutMs = self::DEFAULT_TIMEOUT_MS,
    ) {
        $base = rtrim(trim($baseUrl), "/");
        $parts = parse_url($base);
        if (
            $parts === false ||
            !in_array($parts["scheme"] ?? "", ["http", "https"], true) ||
            ($parts["host"] ?? "") === ""
        ) {
            throw new \InvalidArgumentException(
                "novamem: baseUrl is not an absolute http(s) URL",
            );
        }
        if (trim($token) === "") {
            throw new \InvalidArgumentException("novamem: token is required");
        }
        $this->baseUrl = $base;
        $this->token = $token;
        $this->timeoutMs =
            $timeoutMs > 0 ? $timeoutMs : self::DEFAULT_TIMEOUT_MS;
    }

    /** @internal */
    public function token(): string
    {
        return $this->token;
    }

    /** @return array<string, mixed> */
    public function __debugInfo(): array
    {
        return [
            "baseUrl" => $this->baseUrl,
            "token" => "[redacted]",
            "timeoutMs" => $this->timeoutMs,
        ];
    }
}
