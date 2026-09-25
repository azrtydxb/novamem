<?php

declare(strict_types=1);

namespace Novamem;

/**
 * One method makes every request, so failures are classified once.
 *
 * @internal
 */
final class Transport
{
    /** Responses larger than this are rejected rather than buffered. */
    public const MAX_RESPONSE_BYTES = 8 << 20;

    public function __construct(private readonly Config $cfg) {}

    /** @return array<string, mixed> */
    public function __debugInfo(): array
    {
        return ["config" => $this->cfg];
    }

    private function redact(string $s): string
    {
        return str_replace($this->cfg->token(), "[redacted]", $s);
    }

    /**
     * Performs one request; returns the decoded JSON body (null when
     * $expectBody is false) or throws NovamemException. CURLOPT_TIMEOUT_MS
     * bounds the whole call, redirects included.
     *
     * @param array<string, mixed>|null $query
     */
    public function call(
        string $op,
        string $method,
        string $path,
        mixed $body = null,
        ?array $query = null,
        bool $expectBody = true,
    ): mixed {
        $url = $this->cfg->baseUrl . $path;
        $q = array_filter($query ?? [], fn($v) => $v !== null && $v !== "");
        if ($q !== []) {
            $url .=
                "?" .
                http_build_query(
                    array_map(
                        fn($v) => is_bool($v) ? ($v ? "true" : "false") : $v,
                        $q,
                    ),
                );
        }
        $payload =
            $body === null
                ? null
                : json_encode(
                    $body,
                    JSON_THROW_ON_ERROR |
                        JSON_UNESCAPED_SLASHES |
                        JSON_PRESERVE_ZERO_FRACTION,
                );
        $deadline = hrtime(true) + $this->cfg->timeoutMs * 1_000_000;
        [$status, $raw] = $this->exchange(
            $op,
            $method,
            $url,
            $payload,
            $deadline,
        );
        return $this->decode($op, $status, $raw, $expectBody);
    }

    /**
     * Follows up to 5 redirects itself, so the bearer never reaches another
     * origin (Go's http.Client drops it on a cross-origin hop; so does this).
     * 303, and 301/302 after a POST, continue as a bodyless GET.
     *
     * @return array{0: int, 1: string}
     */
    private function exchange(
        string $op,
        string $method,
        string $url,
        ?string $payload,
        int $deadline,
    ): array {
        $auth = true;
        for ($hop = 0; $hop <= 5; $hop++) {
            [$status, $raw, $location] = $this->request(
                $op,
                $method,
                $url,
                $payload,
                $auth,
                $deadline,
            );
            if (
                $status < 300 ||
                $status >= 400 ||
                $status === 304 ||
                $location === null
            ) {
                return [$status, $raw];
            }
            $next = self::resolve($url, $location);
            $auth = $auth && self::origin($next) === self::origin($url);
            if (
                $status === 303 ||
                (in_array($status, [301, 302], true) && $method === "POST")
            ) {
                $method = "GET";
                $payload = null;
            }
            $url = $next;
        }
        throw new NovamemException(
            $op,
            "too many redirects",
            unavailable: true,
        );
    }

    /** @return array{0: int, 1: string, 2: string|null} */
    private function request(
        string $op,
        string $method,
        string $url,
        ?string $payload,
        bool $auth,
        int $deadline,
    ): array {
        $left = (int) (($deadline - hrtime(true)) / 1_000_000);
        if ($left <= 0) {
            throw new NovamemException(
                $op,
                "timed out",
                unavailable: true,
                retryable: true,
            );
        }
        $headers = ["Accept: application/json"];
        if ($auth) {
            $headers[] = "Authorization: Bearer " . $this->cfg->token();
        }
        if ($payload !== null) {
            $headers[] = "Content-Type: application/json";
        }
        $raw = "";
        $location = null;
        $tooBig = false;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT_MS => $left,
            CURLOPT_CONNECTTIMEOUT_MS => $left,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (
                &$location,
            ): int {
                if (stripos($line, "location:") === 0) {
                    $location = trim(substr($line, 9));
                }
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (
                &$raw,
                &$tooBig,
            ): int {
                if (strlen($raw) + strlen($chunk) > self::MAX_RESPONSE_BYTES) {
                    $tooBig = true;
                    return -1;
                }
                $raw .= $chunk;
                return strlen($chunk);
            },
        ]);
        if ($payload !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        }
        curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($tooBig) {
            throw new NovamemException(
                $op,
                "response body exceeds 8 MiB",
                $status,
                unavailable: true,
            );
        }
        if ($errno === CURLE_OPERATION_TIMEDOUT) {
            throw new NovamemException(
                $op,
                "timed out",
                unavailable: true,
                retryable: true,
            );
        }
        if ($errno !== 0) {
            // Refused dial, DNS, reset, TLS: the host could not be consulted.
            throw new NovamemException(
                $op,
                $this->redact("unreachable: $error"),
                unavailable: true,
                retryable: true,
            );
        }
        return [$status, $raw, $location];
    }

    private function decode(
        string $op,
        int $status,
        string $raw,
        bool $expectBody,
    ): mixed {
        if ($status < 200 || $status >= 300) {
            throw $this->httpError($op, $status, $raw);
        }
        if (!$expectBody) {
            return null;
        }
        if (trim($raw) === "") {
            // A 2xx with no body is not the contract: decoding it into a
            // default would tell a forget caller the delete happened.
            throw new NovamemException(
                $op,
                "empty response body",
                $status,
                unavailable: true,
            );
        }
        try {
            return json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            // In practice a proxy's HTML error page: we never reached a
            // working novamem. Not retryable — it parses the same way again.
            throw new NovamemException(
                $op,
                "malformed response body",
                $status,
                unavailable: true,
            );
        }
    }

    private function httpError(
        string $op,
        int $status,
        string $raw,
    ): NovamemException {
        $message = "";
        $code = "";
        $payload = json_decode($raw, true);
        if (is_array($payload) && ($payload["error"] ?? "") !== "") {
            $message = (string) $payload["error"];
            $code = (string) ($payload["code"] ?? "");
        }
        if ($message === "") {
            // PCRE only (core PHP): ext-curl and ext-json are the promised
            // extensions, so no mbstring. Invalid UTF-8 is replaced, then
            // the text is cut at 256 characters, not bytes.
            $text = trim($raw);
            if (preg_match("//u", $text) !== 1) {
                $text = (string) preg_replace('/[^\x00-\x7F]/', "?", $text);
            }
            $message =
                preg_match("/^.{256}(?=.)/us", $text, $m) === 1
                    ? $m[0] . "…"
                    : $text;
        }
        // The server's message and code are quoted verbatim; a server
        // echoing the credential back would otherwise launder it into logs.
        $message = $this->redact($message);
        $code = $this->redact($code);
        $unavailable = $status >= 500 || $status === 429;
        return new NovamemException(
            $op,
            $message,
            $status,
            $code,
            $unavailable,
            $unavailable,
        );
    }

    private static function origin(string $url): string
    {
        $p = parse_url($url);
        $scheme = strtolower($p["scheme"] ?? "");
        $port = $p["port"] ?? ($scheme === "https" ? 443 : 80);
        return $scheme . "://" . strtolower($p["host"] ?? "") . ":" . $port;
    }

    private static function resolve(string $base, string $location): string
    {
        if (preg_match("#^https?://#i", $location) === 1) {
            return $location;
        }
        $p = parse_url($base);
        $root =
            $p["scheme"] .
            "://" .
            $p["host"] .
            (isset($p["port"]) ? ":" . $p["port"] : "");
        if (str_starts_with($location, "/")) {
            return $root . $location;
        }
        $dir = rtrim(dirname($p["path"] ?? "/"), "/");
        return "$root$dir/$location";
    }
}
