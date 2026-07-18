# Remote Web Host

Experimental, disabled-by-default transport work for serving the upstream Codex
Desktop renderer from a browser while retaining the real Linux Electron main
process and App Host implementation.

## Current Scope

The current version implements the App Host transport and ordinary preload IPC:

- the renderer keeps the upstream RPC client and renderer-owned services;
- a browser automatically selects a WebSocket-backed MessagePort-compatible
  adapter, while `codexRemoteAppHost` can override its endpoint;
- Electron main creates one hidden `BrowserWindow` owner per WebSocket and
  passes the opaque string frames to the original App Host RPC constructor;
- the native Electron MessageChannel path is unchanged when `electronBridge`
  is available and the query parameter is absent;
- the server binds to loopback by default and requires a token for non-loopback
  bind addresses.
- as in `codex-web`, the browser entry removes the Electron-oriented CSP meta
  that otherwise blocks the local WebSocket transport.
- the current upstream preload is reused in the browser with an `electron`
  primitive shim rather than a copied `electronBridge` implementation;
- startup `sendSync` calls are discovered from the extracted preload, executed
  in the real primary Electron renderer, and cached before the browser preload
  runs;
- `invoke`, `send`, subscriptions, and events are relayed generically without
  dispatching on Codex IPC channel names.

Transferred `MessagePort` values outside the dedicated App Host transport use
one-time capabilities. The browser receives a real local `MessagePort`; its
peer is bridged over one same-origin WebSocket to the Electron
`MessagePortMain`. Nested port transfer from inside an already transferred port
is rejected explicitly rather than silently losing ownership semantics.

## Enable

Add the feature to the gitignored `linux-features/features.json`:

```json
{
  "enabled": ["remote-web-host"]
}
```

Build with a known DMG while developing:

```bash
CODEX_DMG_REFRESH_MODE=pinned make build-app
```

The browser uses the same origin for assets and App Host RPC:

```text
http://host:5175/
ws://host:5175/app-host
```

The webview server transparently forwards `/app-host` upgrades to an internal,
loopback-only Electron endpoint. Port `5177` is an implementation detail and
must not be exposed publicly.

After exposing the packaged webview through an SSH tunnel or another local-only
development path, open it directly. The browser derives
`ws(s)://<page-host>/app-host`. Override the endpoint when necessary with
a URL-encoded query value:

```text
?codexRemoteAppHost=ws%3A%2F%2F127.0.0.1%3A5177%2Fapp-host
```

The native Electron renderer does not include this query parameter and keeps
using its original MessageChannel connection.

## Headless Launch

The feature retains the real Electron main process, so a graphical display is
still required even when every user connects through a browser. On a host with
no `DISPLAY` or `WAYLAND_DISPLAY`, launch through Xvfb:

```bash
xvfb-run -a make run-app
```

Without a display, Electron exits during Ozone initialization and the launcher
usually reports status 139. Verify both local endpoints after startup:

```bash
curl http://127.0.0.1:5175/index.html
curl http://127.0.0.1:5177/health
```

The launcher also rejects a Codex CLI whose executable or ancestor directories
are group/world-writable. For a user-owned npm prefix, remove group write access
from the prefix path rather than bypassing the trust check.

## Remote Access

The default remains loopback-only. To listen on a network interface, set both a
webview bind address and a strong random token:

```bash
CODEX_LINUX_WEBVIEW_BIND=0.0.0.0 \
CODEX_REMOTE_WEB_HOST_TOKEN="$(openssl rand -hex 32)" \
xvfb-run -a make run-app
```

Open `http://server:5175/?token=<token>` once. The server removes the token from
the URL and creates an HttpOnly, same-site session cookie. Loopback requests
remain available to the local Electron renderer. Static assets and every
WebSocket route share this authentication boundary. Prefer TLS through a trusted
reverse proxy on untrusted networks.

## Configuration

The feature launcher hook enables `CODEX_REMOTE_WEB_HOST=1`. The server uses
these defaults unless they are already supplied in the launch environment:

- `CODEX_REMOTE_WEB_HOST_BIND=127.0.0.1`
- `CODEX_REMOTE_WEB_HOST_PORT=5177`
- `CODEX_REMOTE_WEB_HOST_TOKEN` is unset for loopback-only development

Binding to any non-loopback address without `CODEX_REMOTE_WEB_HOST_TOKEN`
causes the endpoint to refuse startup. Browser WebSocket clients pass the token
as `?token=...` on the `/app-host` URL. Prefer a reverse proxy or SSH tunnel;
the initial server does not implement TLS.

## Protocol Invariants

The bridge deliberately does not understand App Host messages. It preserves
one text WebSocket message per upstream RPC string frame. Binary frames,
fragmented frames, unmasked client frames, and frames larger than 8 MiB are
rejected.

An upstream update needs attention if any of these invariants changes:

- `connect-app-host` no longer transfers a MessagePort;
- the MessagePort transport starts sending non-string values;
- the main-process `createRpc(port, appHost)` bootstrap changes shape;
- renderer and main bundles no longer share the same RPC implementation.

## Test

```bash
node --test linux-features/remote-web-host/test.js
```

For a generated app, also verify:

```bash
curl http://127.0.0.1:5177/health
```

Then connect two browser surfaces and confirm they receive different hidden
`webContents.id` owners without replacing each other's AppView registration.

## Known Gaps

- Ordinary preload/Electron IPC is not bridged yet.
- Reconnect currently creates a new RPC session; reliable resume must retain the
  existing App Host, hidden owner, and RPC reference state.
- Browser/main build identity negotiation is not implemented yet.
- The packaged webview server remains loopback-only and has no Web authentication
  layer in this feature.
- Hidden owner windows are created directly because no generic remote-surface
  WindowManager hook exists yet.
