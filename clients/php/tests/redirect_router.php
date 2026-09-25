<?php

// Router for RedirectTest's `php -S` servers. With REDIRECT_TO set, a
// request for /health is answered 302 to it; anything else records its
// Authorization header in SEEN_FILE and answers ok.
$to = getenv("REDIRECT_TO");
if (
    $to !== false &&
    $to !== "" &&
    parse_url($_SERVER["REQUEST_URI"], PHP_URL_PATH) === "/health"
) {
    header("Location: " . $to, true, 302);
    return true;
}
file_put_contents(
    (string) getenv("SEEN_FILE"),
    $_SERVER["HTTP_AUTHORIZATION"] ?? "none",
);
header("Content-Type: application/json");
echo '{"ok":true}';
return true;
