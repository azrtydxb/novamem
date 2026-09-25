import http.server
import threading
import unittest

import novamem


def serve(handler):
    srv = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


class Redirects(unittest.TestCase):
    # proved by: building the default opener without _SameOriginAuth fails
    # test_cross_origin_redirect_drops_the_bearer.
    def test_cross_origin_redirect_drops_the_bearer(self):
        seen = {}

        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen["auth"] = self.headers.get("Authorization")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok": true}')

            def log_message(self, *a):
                pass

        target, target_url = serve(Target)

        class Origin(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                # 127.0.0.1 vs localhost: a different origin for the same host.
                self.send_header(
                    "Location", target_url.replace("127.0.0.1", "localhost") + "/health"
                )
                self.end_headers()

            def log_message(self, *a):
                pass

        origin, origin_url = serve(Origin)
        try:
            self.assertTrue(novamem.Client(origin_url, "nm_secret").health())
            self.assertIsNone(
                seen["auth"], "the bearer followed a redirect to another origin"
            )
        finally:
            origin.shutdown()
            target.shutdown()

    def test_same_origin_redirect_keeps_the_bearer(self):
        seen = {}

        class Both(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/health":
                    self.send_response(302)
                    self.send_header("Location", "/moved")
                    self.end_headers()
                    return
                seen["auth"] = self.headers.get("Authorization")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok": true}')

            def log_message(self, *a):
                pass

        srv, url = serve(Both)
        try:
            self.assertTrue(novamem.Client(url, "nm_secret").health())
            self.assertEqual(seen["auth"], "Bearer nm_secret")
        finally:
            srv.shutdown()


if __name__ == "__main__":
    unittest.main()
