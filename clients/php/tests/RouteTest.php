<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class RouteTest extends TestCase
{
    // proved by: renaming Novamem\Client::sessionRecap fails this test.
    public function testEveryRouteIsAccounted(): void
    {
        $routes = json_decode(
            (string) file_get_contents(
                dirname(__DIR__, 2) . "/contract/routes.json",
            ),
            true,
        );
        foreach ($routes as $key => $r) {
            foreach ($r["methods"] ?? [] as $m) {
                [$cls, $meth] = explode(".", $m["name"]);
                $this->assertTrue(
                    method_exists("Novamem\\$cls", lcfirst($meth)),
                    "$key $cls::" . lcfirst($meth),
                );
            }
        }
    }
}
