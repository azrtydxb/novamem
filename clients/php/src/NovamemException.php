<?php

declare(strict_types=1);

namespace Novamem;

/**
 * Every failure of a call. Never contains the bearer token.
 *
 * The one question every caller must be able to answer is "could the store
 * be consulted?" — isUnavailable(). It is true for a refused dial, a
 * timeout, a 5xx, a 429, or a body that is not the JSON the API promises.
 * Any other exception is a real answer that was not success: a rejected
 * token, a bad request, an id that is not in your scope (isNotFound()). An
 * empty result with no exception is the only thing this SDK presents as
 * "nothing is stored".
 */
final class NovamemException extends \RuntimeException
{
    public function __construct(
        private readonly string $op,
        private readonly string $detail,
        private readonly int $statusCode = 0,
        private readonly string $errorCode = "",
        private readonly bool $unavailable = false,
        private readonly bool $retryable = false,
    ) {
        $s = "novamem $op";
        if ($statusCode > 0) {
            $s .= ": $statusCode";
        }
        if ($errorCode !== "") {
            $s .= " [$errorCode]";
        }
        if ($detail !== "") {
            $s .= ": $detail";
        }
        parent::__construct($s);
    }

    /** The client method that failed ("search", "remove-member", …). */
    public function op(): string
    {
        return $this->op;
    }

    /** The HTTP status, or 0 when no response was received. */
    public function statusCode(): int
    {
        return $this->statusCode;
    }

    /** The server's machine-readable error code, when it sent one. */
    public function errorCode(): string
    {
        return $this->errorCode;
    }

    /** The server's message, or a description of the transport failure. */
    public function detail(): string
    {
        return $this->detail;
    }

    /** The store could not be consulted. Say so; do not claim ignorance. */
    public function isUnavailable(): bool
    {
        return $this->unavailable;
    }

    /** Calling again could plausibly succeed. The SDK never retries for you. */
    public function isRetryable(): bool
    {
        return $this->retryable;
    }

    /** The store answered: that id is not in your scope. */
    public function isNotFound(): bool
    {
        return $this->statusCode === 404;
    }
}
