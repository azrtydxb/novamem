#!/bin/sh
# Lints the README's Quickstart (its first ```php block, a complete script
# starting <?php) with `php -l`, so a broken example cannot ship. Syntax
# only: the script is not run, and names are not resolved.
#
#   sh clients/php/check-readme.sh
#
# Needs PHP 8.2+ on the PATH. proved by: a syntax error in the quickstart
# fails `php -l`.
set -eu
cd "$(dirname "$0")"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

awk 'f && /^```/ { exit } f { print } !f && $0 == "```php" { f = 1 }' README.md >"$tmp/quickstart.php"
if ! head -n 1 "$tmp/quickstart.php" | grep -q '^<?php'; then
	echo "readme php: the first \`\`\`php block in README.md is not a script starting <?php" >&2
	exit 1
fi

if ! php -l "$tmp/quickstart.php" >/dev/null; then
	echo "readme php: quickstart does not parse" >&2
	exit 1
fi
echo "readme php: quickstart ok"
