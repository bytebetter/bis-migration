#!/usr/bin/env python3
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


SHARE_PATH = os.getenv("SHARE_PATH", "/data/shared")


def check_share_rw():
    ts = str(int(time.time() * 1000))
    probe_file = os.path.join(SHARE_PATH, f".probe-{ts}.tmp")
    payload = f"probe-{ts}"

    if not os.path.isdir(SHARE_PATH):
        return False, f"path_not_found:{SHARE_PATH}"

    try:
        with open(probe_file, "w", encoding="utf-8") as fp:
            fp.write(payload)
            fp.flush()
            os.fsync(fp.fileno())

        with open(probe_file, "r", encoding="utf-8") as fp:
            content = fp.read()

        if content != payload:
            return False, "read_mismatch"

        os.remove(probe_file)
        return True, "ok"
    except Exception as exc:  # pragma: no cover
        try:
            if os.path.exists(probe_file):
                os.remove(probe_file)
        except OSError:
            pass
        return False, f"{type(exc).__name__}:{exc}"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/", "/health", "/healthz"):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"not_found")
            return

        is_ok, message = check_share_rw()
        code = 200 if is_ok else 500
        body = f"{message}\n".encode("utf-8")

        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        return


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8081"))
    server = HTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()
