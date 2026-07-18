# Browser Bridge Design

## Constraint

The browser sees one origin only. HTTP assets, ordinary IPC, App Host RPC, and
future worker transports must be routed below the same public host and port.
Internal loopback ports are implementation details and must not be exposed.

## Preserve Upstream Boundaries

Do not add one WebSocket method for every App Host service or every
`electronBridge` method. Keep the upstream preload as the owner of
`electronBridge` and provide browser-compatible Electron primitives beneath it:

```text
upstream renderer
  -> upstream preload / electronBridge
    -> browser electron shim
      -> generic IPC transport
        -> hidden Electron relay renderer
          -> real ipcRenderer
            -> unchanged ipcMain handlers
```

App Host remains a separate opaque MessagePort transport. Its string frames are
forwarded without decoding or service-specific routing.

## Capability Classification

### Must Bridge Transparently

- `ipcRenderer.invoke(channel, ...args)` request/response, including errors.
- `ipcRenderer.on`, `once`, `removeListener`, and `removeAllListeners` events.
- `ipcRenderer.send` when a future preload starts using fire-and-forget IPC.
- Startup `ipcRenderer.sendSync` through build-time discovery and an asynchronous
  preload snapshot populated before the upstream bridge is exposed. Runtime
  sendSync calls outside that snapshot remain unsupported.
- `ipcRenderer.postMessage` with transferred `MessagePort` for App Host and MCP
  sandbox channels; ports need dedicated opaque stream identifiers because
  structured clone cannot cross a network socket directly.
- Electron structured-clone values used by IPC: primitives, arrays, plain
  objects, `Buffer`/typed arrays, errors, and transferable-port references.
- Main-to-renderer broadcasts and subscription lifecycle per browser session.
- Reconnect identity, bounded replay, pending invoke rejection, and relay-owner
  cleanup when a browser session expires.

### Implement With Web APIs

- Context and application menus: render browser menus from the upstream menu
  model or return a browser-specific no-op where no action is required.
- File selection and upload: browser file picker plus a same-origin upload
  endpoint; return server-side paths only after explicit upload.
- Workspace directory selection: a server-side directory picker or an explicit
  configured-root browser UI, never a fake local browser path.
- File drag and drop: browser `DataTransfer`; desktop-only drag-out can degrade
  to download.
- External links: `window.open` with an allowlist instead of `shell.openExternal`.
- Theme and visibility: `matchMedia`, Page Visibility, and browser lifecycle
  events where they represent the same semantics.
- Clipboard, notifications, and downloads: browser APIs with permission checks.
- Routing and window history: browser History API.

### Disable Or Degrade Explicitly

- Native titlebar, dock, tray, window bounds, minimize/maximize, and traffic-light
  controls.
- Native application-menu placement and OS-global keyboard shortcuts.
- Finder/File Explorer reveal operations when no server-side equivalent is
  meaningful.
- Device checks tied to macOS hardware or Electron process architecture.
- Dragging a server file directly into another client-side desktop application.
- APIs that expose unrestricted host filesystem paths to an unauthenticated
  browser.

Disabling must be capability-based and visible to the renderer. Do not silently
return plausible but incorrect values.

## Low-Drift Strategy

1. Bundle the current upstream preload for the browser while aliasing only the
   `electron` module to a stable shim. Avoid copying `electronBridge` methods.
2. Keep the wire protocol generic and versioned around IPC primitives, not
   channel names or App Host services.
3. Run each browser session through one hidden Electron relay renderer so real
   `ipcRenderer` reaches unchanged upstream `ipcMain` handlers.
4. Treat transferred ports as opaque multiplexed streams. App Host payloads
   remain untouched.
5. Generate compatibility checks from the extracted preload on every build:
   fail if it imports a new Electron module member or IPC primitive not covered
   by the shim.
6. Record observed channel names for diagnostics only. They must not be the
   relay dispatch table.
7. Keep protocol conformance tests independent of minified symbol names, and
   smoke-test the freshly extracted upstream preload against a fake primitive
   transport.

Expected upstream drift is therefore limited to new Electron primitives,
non-serializable value types, or changed lifecycle assumptions. New ordinary
IPC channels and new App Host services should pass through without code changes.

## Public Routes

All browser-visible routes share one origin:

```text
GET  /*                         static renderer and SPA fallback
WS   /app-host                 reliable opaque App Host transport
WS   /electron-ipc             reliable asynchronous IPC/event transport
WS   /message-port/:id         reliable transferred MessagePort transport
GET  /health                   readiness and protocol versions
```

The service must sit behind authentication before binding beyond loopback.
Origin checks, session cookies, CSRF protection for HTTP endpoints, WebSocket
origin validation, message-size limits, and per-session resource limits are
required before remote deployment.

The Electron bridge always listens on `127.0.0.1:5177`. The authenticated
public server proxies the routes above from port `5175`; the internal bridge
cannot be configured to bind directly to a network interface. `/health`
returns `protocolVersion`, `buildId`, and `serverEpoch` for compatibility
diagnostics.

## Implementation Status

- Implemented: same-origin static assets, `/app-host`, and `/electron-ipc`.
- Implemented: generated browser preload based on the current upstream preload.
- Implemented: startup `sendSync` snapshot on the real primary `webContents`.
- Implemented: generic `invoke`, `send`, subscribe, unsubscribe, and events.
- Implemented: one-time transferable-port capabilities backed by a real local
  browser `MessageChannel` and one reliable same-origin session per remote port.
- Implemented: explicit browser-port close wrapping and permanent reset when
  either endpoint or a transferred-port capability is no longer available.
- Implemented: token-gated non-loopback bind and same-origin WebSocket checks.
- Implemented: sequence/ACK replay, keepalive, five-minute grace, build identity
  rejection, and bounded send buffers for all three WebSocket transports.
- Pending: nested port transfer within an already transferred port.
