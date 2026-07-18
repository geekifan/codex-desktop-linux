#!/usr/bin/env python3
import ctypes
import ctypes.util
import functools
import hmac
import http.server
import os
import posixpath
import signal
import select
import socket
import sys
import urllib.parse


USER_STYLESHEET_ENDPOINT = "/__codex_user_stylesheet.css"
MAX_USER_STYLESHEET_BYTES = 256 * 1024
WEBSOCKET_PROXY = os.environ.get("CODEX_LINUX_WEBVIEW_WEBSOCKET_PROXY", "").strip()
REMOTE_WEB_TOKEN = os.environ.get("CODEX_REMOTE_WEB_HOST_TOKEN", "")


def _parse_websocket_proxy(value):
    routes = {}
    for entry in value.split(";"):
        if "=" not in entry:
            continue
        request_path, target = entry.split("=", 1)
        host, separator, port_text = target.rpartition(":")
        if not request_path.startswith("/") or not separator or not host:
            continue
        try:
            target_port = int(port_text)
        except ValueError:
            continue
        if 1 <= target_port <= 65535:
            routes[request_path] = (host, target_port)
    return routes


WEBSOCKET_PROXY_CONFIG = _parse_websocket_proxy(WEBSOCKET_PROXY)


def _install_parent_death_signal():
    # Ensure the kernel terminates this process if the launcher (parent) exits
    # without invoking its cleanup trap (SIGKILL, OOM, crash). Without this,
    # the HTTP server can outlive the launcher and block its webview port,
    # which is fatal for multi-instance launches pinned to a single port.
    if sys.platform != "linux":
        return
    libc_name = ctypes.util.find_library("c") or "libc.so.6"
    try:
        libc = ctypes.CDLL(libc_name, use_errno=True)
    except OSError:
        return
    PR_SET_PDEATHSIG = 1
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0:
        return
    # The parent may have died between fork() and prctl(); in that case the
    # death signal never fires. Bail out now so the port is freed promptly.
    if os.getppid() == 1:
        os._exit(0)


_install_parent_death_signal()


port = int(sys.argv[1])
bind = "127.0.0.1"
if len(sys.argv) >= 4 and sys.argv[2] == "--bind":
    bind = sys.argv[3]
if bind not in ("127.0.0.1", "::1", "localhost") and not REMOTE_WEB_TOKEN:
    raise SystemExit("CODEX_REMOTE_WEB_HOST_TOKEN is required for a non-loopback webview bind")


class CodexWebviewHandler(http.server.SimpleHTTPRequestHandler):
    def is_loopback_client(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def is_authorized(self):
        if self.is_loopback_client() or not REMOTE_WEB_TOKEN:
            return True
        cookie = self.headers.get("Cookie", "")
        values = dict(
            part.strip().split("=", 1)
            for part in cookie.split(";")
            if "=" in part
        )
        return hmac.compare_digest(values.get("codex_remote_token", ""), REMOTE_WEB_TOKEN)

    def accept_token_query(self):
        if self.is_loopback_client() or not REMOTE_WEB_TOKEN:
            return False
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        provided = query.get("token", [""])[0]
        if not hmac.compare_digest(provided, REMOTE_WEB_TOKEN):
            return False
        query.pop("token", None)
        location = urllib.parse.urlunsplit(("", "", url.path, urllib.parse.urlencode(query, doseq=True), url.fragment))
        self.send_response(303)
        self.send_header("Set-Cookie", f"codex_remote_token={REMOTE_WEB_TOKEN}; HttpOnly; SameSite=Strict; Path=/")
        self.send_header("Location", location or "/")
        self.end_headers()
        return True

    def reject_unauthorized(self):
        self.send_response(401)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", "12")
        self.end_headers()
        self.wfile.write(b"Unauthorized")

    def normalized_request_path(self):
        request_path = urllib.parse.urlsplit(self.path).path
        decoded_path = urllib.parse.unquote(request_path)
        normalized_path = posixpath.normpath(decoded_path)
        if decoded_path.endswith("/") and not normalized_path.endswith("/"):
            normalized_path += "/"
        if not normalized_path.startswith("/"):
            normalized_path = "/" + normalized_path
        return normalized_path

    def send_head(self):
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]
        return super().send_head()

    def user_stylesheet_path(self):
        configured = os.environ.get("CODEX_LINUX_WEBVIEW_USER_STYLESHEET", "").strip()
        if not configured:
            configured = os.environ.get("CODEX_LINUX_WEBVIEW_USER_STYLESHEET_DEFAULT", "").strip()
        if not configured:
            return None
        return os.path.expanduser(os.path.expandvars(configured))

    def serve_user_stylesheet(self):
        payload = b""
        try:
            css_path = self.user_stylesheet_path()
            if css_path is None or not os.path.isfile(css_path):
                raise OSError("user stylesheet is missing or is not a file")
            with open(css_path, "rb") as handle:
                payload = handle.read(MAX_USER_STYLESHEET_BYTES + 1)
            if len(payload) > MAX_USER_STYLESHEET_BYTES:
                payload = b""
        except OSError:
            payload = b""
        self.send_response(200)
        self.send_header("Content-Type", "text/css; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def do_GET(self):
        if self.accept_token_query():
            return
        if not self.is_authorized():
            self.reject_unauthorized()
            return
        if self.proxy_websocket():
            return
        if self.normalized_request_path() == USER_STYLESHEET_ENDPOINT:
            self.serve_user_stylesheet()
            return
        return super().do_GET()

    def proxy_websocket(self):
        normalized_path = self.normalized_request_path()
        target = WEBSOCKET_PROXY_CONFIG.get(normalized_path)
        if target is None:
            target = next(
                (
                    route_target
                    for route_path, route_target in WEBSOCKET_PROXY_CONFIG.items()
                    if route_path.endswith("/") and normalized_path.startswith(route_path)
                ),
                None,
            )
        if target is None:
            return False
        target_host, target_port = target
        if self.headers.get("Upgrade", "").lower() != "websocket":
            return False
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get("Host", ""):
            self.send_error(403, "WebSocket origin does not match Host")
            return True

        upstream = socket.create_connection((target_host, target_port), timeout=10)
        upstream.settimeout(None)
        try:
            request = [f"GET {self.path} HTTP/1.1\r\n"]
            request.extend(f"{name}: {value}\r\n" for name, value in self.headers.items())
            request.append("\r\n")
            upstream.sendall("".join(request).encode("latin-1"))
            self.close_connection = True
            sockets = (self.connection, upstream)
            while True:
                readable, _, _ = select.select(sockets, (), (), 60)
                if not readable:
                    continue
                for source in readable:
                    payload = source.recv(64 * 1024)
                    if not payload:
                        return True
                    destination = upstream if source is self.connection else self.connection
                    destination.sendall(payload)
        finally:
            upstream.close()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


handler = functools.partial(CodexWebviewHandler, directory=".")
with http.server.ThreadingHTTPServer((bind, port), handler) as httpd:
    httpd.serve_forever()
