#!/usr/bin/env python3
"""Static file server for the OpenWrt rebuilder frontend that proxies /api/* to the rebuilderd daemon.

Usage:
    ./serve.py                          # serves on :8882, proxies to 127.0.0.1:8484
    ./serve.py --port 9000              # override listen port
    ./serve.py --upstream host:port     # override daemon address
"""
import argparse
import http.server
import os
import urllib.error
import urllib.request
from functools import partial


class Handler(http.server.SimpleHTTPRequestHandler):
    upstream = "http://127.0.0.1:8484"

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            super().do_GET()

    def _proxy(self):
        url = self.upstream + self.path
        req = urllib.request.Request(url, method="GET")
        for h in ("Accept", "If-Modified-Since", "If-None-Match"):
            v = self.headers.get(h)
            if v is not None:
                req.add_header(h, v)
        try:
            with urllib.request.urlopen(req) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in ("transfer-encoding", "connection", "content-encoding"):
                        continue
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except urllib.error.URLError as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(f"upstream unreachable: {e}".encode())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8882)
    p.add_argument("--upstream", default="http://127.0.0.1:8484")
    args = p.parse_args()

    Handler.upstream = args.upstream.rstrip("/")
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    handler = partial(Handler, directory=".")
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"serving frontend on http://127.0.0.1:{args.port}  (api → {Handler.upstream})")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
