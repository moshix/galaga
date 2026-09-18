#!/usr/bin/env python3
# Copyright 2026 by Moshix
"""Static server for local development, with caching turned off.

`python3 -m http.server` sends Last-Modified but no Cache-Control and no ETag,
so Chrome falls back to *heuristic* caching: it may reuse a script for roughly
10% of the file's age without revalidating. During development that means an
edit can appear to have no effect, which is a genuinely confusing failure -- the
page loads, the console is clean, and the old code runs.

This serves the same files with `Cache-Control: no-store`, so every reload
fetches what is actually on disk.

    python3 tools/serve.py [port]        default port 8000
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the console readable; only report anything that is not a 200.
        status = args[1] if len(args) > 1 else ""
        if not str(status).startswith("2"):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = Path(__file__).resolve().parent.parent
    handler = partial(NoCacheHandler, directory=str(root))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Galaga: http://localhost:{port}/   (serving {root}, caching disabled)")
        print("press 5 to insert a coin, then 1 to start.  Ctrl-C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
