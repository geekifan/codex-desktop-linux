"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  applyMainBundlePatch,
  applyRendererBundlePatch,
  applyRendererAssetsPatch,
  applyExtractedWebviewCspPatch,
  applyRemoteBuildIdentity,
  applyWebviewCspPatch,
  buildBrowserPreload,
  browserReliableTransportSource,
  findStartupSendSyncChannels,
  descriptors,
} = require("./patch.js");
const {
  ReliableSession,
  RpcMessagePort,
  WebSocketPeer,
  acceptReliablePeer,
  createAppHostSession,
  createTransferredPortSession,
  encodeFrame,
  websocketAccept,
} = require("./runtime/app-host-server.cjs");

class FakePeer extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this.closed = false;
  }

  sendText(value) {
    this.frames.push(JSON.parse(value));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeBrowserWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeBrowserWebSocket.CONNECTING;
    this.sent = [];
    FakeBrowserWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    this.on(type, listener);
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  open() {
    this.readyState = FakeBrowserWebSocket.OPEN;
    this.emit("open");
  }

  receive(value) {
    this.emit("message", { data: JSON.stringify(value) });
  }

  close() {
    if (this.readyState === FakeBrowserWebSocket.CLOSED) return;
    this.readyState = FakeBrowserWebSocket.CLOSED;
    this.emit("close");
  }
}

function maskedTextFrame(value, mask = Buffer.from([1, 2, 3, 4])) {
  const payload = Buffer.from(value, "utf8");
  assert.ok(payload.length < 126);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) {
    body[index] ^= mask[index % 4];
  }
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, body]);
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(value) {
    this.writes.push(Buffer.from(value));
  }

  end(value) {
    if (value != null) this.write(value);
    this.emit("close");
  }
}

class FakeMessagePort extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.closed = false;
  }

  postMessage(value) {
    this.messages.push(value);
  }

  start() {}

  close() {
    this.closed = true;
  }
}

class FakeDomMessagePort extends EventEmitter {
  constructor() {
    super();
    this.closeCount = 0;
    this.messages = [];
  }

  addEventListener(type, listener) {
    this.on(type, listener);
  }

  postMessage(value) {
    this.messages.push(value);
  }

  start() {}

  close() {
    this.closeCount += 1;
  }
}

function createRemoteMessagePortHarness() {
  const browserSource = buildBrowserPreload(
    "let e=require(`electron`),a=`sync-a`,x=e.ipcRenderer.sendSync(a),j={x};",
  );
  const functionStart = browserSource.indexOf("function codexLinuxRemoteMessagePort");
  const functionEnd = browserSource.indexOf("\ncodexLinuxIpcSocket.addEventListener", functionStart);
  const ports = [];
  const channel = new EventEmitter();
  channel.closeCount = 0;
  channel.addEventListener = channel.on.bind(channel);
  channel.close = () => {
    channel.closeCount += 1;
  };
  channel.send = () => {};
  let channelOptions;
  const context = {
    MessageChannel: class {
      constructor() {
        this.port1 = new FakeDomMessagePort();
        this.port2 = new FakeDomMessagePort();
        ports.push(this.port1, this.port2);
      }
    },
    codexLinuxCreateReliableChannel: (_url, options) => {
      channelOptions = options;
      return channel;
    },
    encodeURIComponent,
    location: { host: "localhost:5175", protocol: "http:" },
  };
  context.globalThis = context;
  context.__codexLinuxRemoteBuildId = "1.0";
  vm.runInNewContext(
    `${browserSource.slice(functionStart, functionEnd)};globalThis.createRemoteMessagePort=codexLinuxRemoteMessagePort`,
    context,
  );
  return {
    channel,
    channelOptions: () => channelOptions,
    createPort: (descriptor = { portId: "port-1", token: "secret" }) => context.createRemoteMessagePort(descriptor),
    ports,
  };
}

test("feature remains optional and owns both transport patches", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.phase),
    ["main-bundle", "extracted-app:pre-webview", "extracted-app:pre-webview", "extracted-app:post-webview"],
  );
});

test("webview patch removes the browser-blocking CSP meta", () => {
  const source =
    '<head>\n  <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; connect-src &#39;self&#39;;">\n  <script type="module" crossorigin src="./assets/index-current.js"></script>\n</head>';
  const patched = applyWebviewCspPatch(source);
  assert.doesNotMatch(patched, /Content-Security-Policy/u);
  assert.equal(applyWebviewCspPatch(patched), patched);

  const extractedDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "remote-web-host-"));
  fs.mkdirSync(path.join(extractedDir, "webview"));
  fs.mkdirSync(path.join(extractedDir, "webview", "assets"));
  fs.mkdirSync(path.join(extractedDir, ".vite", "build"), { recursive: true });
  fs.writeFileSync(path.join(extractedDir, "webview", "index.html"), source);
  fs.writeFileSync(
    path.join(extractedDir, ".vite", "build", "preload.js"),
    "let e=require(`electron`),a=`sync-a`;let value=e.ipcRenderer.sendSync(a),j={value};e.contextBridge.exposeInMainWorld(`electronBridge`,j);",
  );
  assert.deepEqual(applyExtractedWebviewCspPatch(extractedDir), { matched: true, changed: true });
  assert.deepEqual(applyExtractedWebviewCspPatch(extractedDir), { matched: true, changed: false });
  assert.deepEqual(applyRemoteBuildIdentity(extractedDir), { matched: true, changed: true });
  const patchedIndex = fs.readFileSync(path.join(extractedDir, "webview", "index.html"), "utf8");
  assert.doesNotMatch(patchedIndex, /Content-Security-Policy/u);
  assert.doesNotMatch(patchedIndex, /<script type="module" crossorigin/u);
  assert.ok(
    patchedIndex.indexOf('await import("./assets/codex-linux-remote-preload.js");') <
      patchedIndex.indexOf('await import("./assets/index-current.js");'),
  );
  assert.match(
    fs.readFileSync(path.join(extractedDir, "webview", "assets", "codex-linux-remote-preload.js"), "utf8"),
    /__codexElectronShim/u,
  );
  const buildId = fs.readFileSync(path.join(extractedDir, ".codex-linux-remote-build-id"), "utf8");
  assert.match(buildId, /^[a-f0-9]{64}$/u);
  assert.match(
    fs.readFileSync(path.join(extractedDir, "webview", "assets", "codex-linux-remote-preload.js"), "utf8"),
    new RegExp(buildId, "u"),
  );
  const stableBuildId = fs.readFileSync(path.join(extractedDir, ".codex-linux-remote-build-id"), "utf8");
  assert.deepEqual(applyRemoteBuildIdentity(extractedDir), { matched: true, changed: false });
  fs.writeFileSync(path.join(extractedDir, "webview", "assets", "renderer-change.js"), "changed renderer");
  assert.deepEqual(applyRemoteBuildIdentity(extractedDir), { matched: true, changed: true });
  assert.notEqual(
    fs.readFileSync(path.join(extractedDir, ".codex-linux-remote-build-id"), "utf8"),
    stableBuildId,
  );
  fs.rmSync(extractedDir, { recursive: true });
});

test("extracted patches fail explicitly when required upstream files drift", () => {
  const extractedDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "remote-web-host-drift-"));
  assert.throws(
    () => applyExtractedWebviewCspPatch(extractedDir),
    /Could not find extracted webview index/u,
  );
  assert.throws(
    () => applyRemoteBuildIdentity(extractedDir),
    /Could not find generated browser preload/u,
  );
  fs.rmSync(extractedDir, { recursive: true });
});

test("browser preload preserves upstream bridge and snapshots startup sendSync calls", () => {
  const source =
    "let e=require(`electron`),a=`sync-a`,b=`sync-b`,x=e.ipcRenderer.sendSync(a),y=e.ipcRenderer.sendSync(b),z=e.ipcRenderer.sendSync(`sync-c`),j={x,y,z};";
  assert.deepEqual(findStartupSendSyncChannels(source), ["sync-a", "sync-b", "sync-c"]);
  const browserSource = buildBrowserPreload(source);
  assert.match(browserSource, /^if\(globalThis\.electronBridge==null\)\{/u);
  assert.doesNotMatch(browserSource, /require\(`electron`\)/u);
  assert.match(browserSource, /globalThis\.__codexElectronShim/u);
  assert.match(browserSource, /\["sync-a","sync-b","sync-c"\]/u);
});

test("browser reliable channel reconnects with the same identity and replays", () => {
  FakeBrowserWebSocket.instances = [];
  const context = vm.createContext({
    WebSocket: FakeBrowserWebSocket,
    TextEncoder,
    clearInterval() {},
    clearTimeout() {},
    console,
    crypto: { randomUUID: () => "browser-connection-id" },
    globalThis: null,
    location: { reload() {} },
    setInterval: () => 1,
    setTimeout: (callback) => {
      callback();
      return 1;
    },
  });
  context.globalThis = context;
  vm.runInContext(browserReliableTransportSource(), context);
  const channel = context.codexLinuxCreateReliableChannel("ws://example/app-host", { buildId: "1.0" });
  const first = FakeBrowserWebSocket.instances[0];
  first.open();
  const hello = first.sent[0];
  first.receive({
    type: "bridge-ready",
    protocolVersion: 1,
    connectionId: hello.connectionId,
    serverEpoch: "epoch-1",
    buildId: "1.0",
  });
  channel.send("opaque-rpc");
  first.close();
  const second = FakeBrowserWebSocket.instances[1];
  second.open();
  assert.equal(second.sent[0].connectionId, hello.connectionId);
  assert.equal(second.sent[0].serverEpoch, "epoch-1");
  second.receive({
    type: "bridge-ready",
    protocolVersion: 1,
    connectionId: hello.connectionId,
    serverEpoch: "epoch-1",
    buildId: "1.0",
  });
  assert.equal(second.sent.find((frame) => frame.type === "bridge-data").message, "opaque-rpc");
  channel.close();
});

test("launcher hook enables the feature without overriding transport settings", () => {
  const hook = path.join(__dirname, "launcher-hook.sh");
  childProcess.execFileSync("bash", ["-n", hook]);
  assert.equal(childProcess.execFileSync(hook, { encoding: "utf8" }), "env CODEX_REMOTE_WEB_HOST=1\n");
});

test("same-origin WebSocket proxy clears the connect timeout", () => {
  const proxy = fs.readFileSync(
    path.join(__dirname, "..", "..", "launcher", "webview-server.py"),
    "utf8",
  );

  assert.match(proxy, /socket\.create_connection\([^\n]+timeout=10\)\n\s+upstream\.settimeout\(None\)/u);
  assert.match(proxy, /CODEX_LINUX_WEBVIEW_HTTP_PROXY/u);
  assert.match(proxy, /def proxy_http\(self\):/u);
  assert.match(
    fs.readFileSync(path.join(__dirname, "webview-proxy.env"), "utf8"),
    /CODEX_LINUX_WEBVIEW_HTTP_PROXY=\/health=127\.0\.0\.1:5177/u,
  );
});

test("main patch adds one transparent server bootstrap", () => {
  const source = [
    "function u6(e,t,n){return new rpc.Connection(new d6(e),t,n).getRemoteMain()}",
    "function setup(){electron.ipcMain.on(channels.connect,event=>{if(!trusted(event))return;let[port]=event.ports,context=getContext(event.sender),host=context?.createAppHost(event.sender),remote=u6(port,host);context?.registerAppView(event.sender,remote).catch(()=>console.warn(`Failed to register AppView RPC services`))})}",
  ].join("");
  const patched = applyMainBundlePatch(source);
  assert.match(patched, /function codexLinuxRemoteWebHostStart/u);
  assert.match(patched, /codexLinuxRemoteWebHostStart\(electron,getContext\),electron\.ipcMain/u);
  assert.match(patched, /createRpc:\(e,t\)=>u6\(e,t\)/u);
  assert.equal(applyMainBundlePatch(patched), patched);
});

test("renderer patch preserves native bootstrap and selects WebSocket in browsers", () => {
  const source =
    "function OBe(){let{port1:e,port2:t}=new MessageChannel;return window.postMessage({type:`connect-app-host`,port:t},window.location.origin,[t]),BM(e,EBe)}";
  const patched = applyRendererBundlePatch(source);
  assert.match(patched, /function codexLinuxRemoteWebSocketMessagePort/u);
  assert.match(patched, /codexRemoteAppHost/u);
  assert.match(patched, /globalThis\.__codexLinuxRemoteWebHost===!0/u);
  assert.match(patched, /window\.location\.host\}\/app-host/u);
  assert.match(patched, /new MessageChannel/u);
  assert.match(patched, /globalThis\.__codexLinuxRemoteWebHost===!0/u);
  assert.match(patched, /BM\(codexLinuxRemoteWebSocketMessagePort/u);
  assert.equal(applyRendererBundlePatch(patched), patched);
});

test("renderer asset patch scans by content and fails explicitly on drift", () => {
  const extractedDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "remote-renderer-assets-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "unrelated.js"), "function renderer(){}");
  assert.throws(() => applyRendererAssetsPatch(extractedDir), /Could not find renderer App Host channel/u);
  fs.writeFileSync(
    path.join(assetsDir, "current.js"),
    "function OBe(){let{port1:e,port2:t}=new MessageChannel;return window.postMessage({type:`connect-app-host`,port:t},window.location.origin,[t]),BM(e,EBe)}",
  );
  assert.deepEqual(applyRendererAssetsPatch(extractedDir), { matched: true, changed: true });
  assert.deepEqual(applyRendererAssetsPatch(extractedDir), { matched: true, changed: false });
  fs.rmSync(extractedDir, { recursive: true });
});

test("WebSocket accept key follows RFC 6455", () => {
  assert.equal(
    websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});

test("internal bridge is fixed to loopback and reports compatibility identity", () => {
  const runtime = fs.readFileSync(path.join(__dirname, "runtime", "app-host-server.cjs"), "utf8");
  assert.match(runtime, /const bind = "127\.0\.0\.1";/u);
  assert.match(runtime, /const port = 5177;/u);
  assert.doesNotMatch(runtime, /CODEX_REMOTE_WEB_HOST_BIND/u);
  assert.match(runtime, /protocolVersion: RELIABLE_PROTOCOL_VERSION/u);
  assert.match(runtime, /buildId,/u);
  assert.match(runtime, /serverEpoch,/u);
  assert.match(runtime, /transferred MessagePort unavailable/u);
});

test("browser transferred port explicitly closes its reliable channel", () => {
  const harness = createRemoteMessagePortHarness();
  const port = harness.createPort();
  port.close();
  assert.equal(harness.channel.closeCount, 1);
  assert.equal(harness.ports[0].closeCount, 1);
  assert.equal(harness.ports[1].closeCount, 1);
  assert.equal(harness.channelOptions().reloadOnReset, false);
});

test("browser transferred port stops without reconnecting after a permanent reset", () => {
  const harness = createRemoteMessagePortHarness();
  harness.createPort();
  harness.channel.emit("reset", { reason: "transferred MessagePort unavailable" });
  assert.equal(harness.channel.closeCount, 0);
  assert.equal(harness.ports[0].closeCount, 1);
  assert.equal(harness.ports[1].closeCount, 1);
});

test("reliable session replays unacknowledged messages after socket replacement", () => {
  const session = new ReliableSession({ connectionId: "session-1", serverEpoch: "epoch-1", buildId: "1.0" });
  const first = new FakePeer();
  session.attach(first);
  session.send("one");
  session.send("two");
  first.emit("text", JSON.stringify({ type: "bridge-ack", ack: 1 }));
  first.close();

  const second = new FakePeer();
  session.attach(second);
  assert.deepEqual(
    second.frames.filter((frame) => frame.type === "bridge-data"),
    [{ type: "bridge-data", id: 2, ack: 0, message: "two" }],
  );
  session.dispose();
});

test("reliable session deduplicates replayed incoming messages", () => {
  const session = new ReliableSession({ connectionId: "session-2", serverEpoch: "epoch-1", buildId: "1.0" });
  const peer = new FakePeer();
  const messages = [];
  session.on("message", (message) => messages.push(message));
  session.attach(peer);
  const frame = JSON.stringify({ type: "bridge-data", id: 1, ack: 0, message: { value: 1 } });
  peer.emit("text", frame);
  peer.emit("text", frame);
  assert.deepEqual(messages, [{ value: 1 }]);
  assert.equal(peer.frames.at(-1).ack, 1);
  session.dispose();
});

test("reliable session requests replay for an incoming gap", () => {
  const session = new ReliableSession({ connectionId: "session-3", serverEpoch: "epoch-1", buildId: "1.0" });
  const peer = new FakePeer();
  session.attach(peer);
  peer.emit("text", JSON.stringify({ type: "bridge-data", id: 2, ack: 0, message: "late" }));
  assert.deepEqual(peer.frames.at(-1), { type: "bridge-replay-request", ack: 0 });
  session.dispose();
});

test("reliable session rejects acknowledgements beyond the sent window", () => {
  const session = new ReliableSession({
    connectionId: "session-ack",
    serverEpoch: "epoch-1",
    buildId: "1.0",
    maxInFlightBytes: 8,
  });
  const peer = new FakePeer();
  let reason;
  session.once("dispose", (value) => {
    reason = value;
  });
  session.attach(peer);
  session.send("one");
  session.send("two");
  peer.emit("text", JSON.stringify({ type: "bridge-ack", ack: 2 }));
  assert.equal(reason, "invalid reliable bridge acknowledgement");
});

test("reliable session does not echo an incoming keepalive", () => {
  const session = new ReliableSession({ connectionId: "session-ping", serverEpoch: "epoch-1", buildId: "1.0" });
  const peer = new FakePeer();
  session.attach(peer);
  const frameCount = peer.frames.length;
  peer.emit("text", JSON.stringify({ type: "bridge-keepalive" }));
  assert.equal(peer.frames.length, frameCount);
  session.dispose();
});

test("reliable session allows one message to exceed an empty send window", () => {
  const session = new ReliableSession({
    connectionId: "session-window",
    serverEpoch: "epoch-1",
    buildId: "1.0",
    maxInFlightBytes: 5,
  });
  const peer = new FakePeer();
  session.attach(peer);
  assert.equal(session.send("oversized"), true);
  assert.equal(peer.frames.at(-1).message, "oversized");
  session.dispose();
});

test("reliable session snapshots mutable payloads before replay", () => {
  const session = new ReliableSession({ connectionId: "session-snapshot", serverEpoch: "epoch-1", buildId: "1.0" });
  const first = new FakePeer();
  session.attach(first);
  const value = { count: 1 };
  session.send(value);
  value.count = 2;
  first.close();
  const second = new FakePeer();
  session.attach(second);
  assert.deepEqual(second.frames.find((frame) => frame.type === "bridge-data").message, { count: 1 });
  session.dispose();
});

test("reliable session rejects a peer that is already closed", () => {
  const session = new ReliableSession({ connectionId: "session-closed", serverEpoch: "epoch-1", buildId: "1.0" });
  const peer = new FakePeer();
  peer.closed = true;
  assert.equal(session.attach(peer), false);
  assert.equal(session.peer, null);
  session.dispose();
});

test("reliable session does not attach when the peer closes during handshake", () => {
  const session = new ReliableSession({ connectionId: "session-handshake-close", serverEpoch: "epoch-1", buildId: "1.0" });
  const peer = new FakePeer();
  let attached = 0;
  session.on("attached", () => {
    attached += 1;
  });
  peer.sendText = () => peer.close();
  assert.equal(session.attach(peer), false);
  assert.equal(attached, 0);
  assert.equal(session.peer, null);
  assert.equal(session.keepaliveTimer, null);
  assert.notEqual(session.graceTimer, null);
  session.dispose();
});

test("reliable session rejects replay acknowledgements older than retained history", () => {
  const session = new ReliableSession({ connectionId: "session-old-replay", serverEpoch: "epoch-1", buildId: "1.0" });
  const peer = new FakePeer();
  let reason;
  session.once("dispose", (value) => {
    reason = value;
  });
  session.attach(peer);
  session.send("one");
  session.send("two");
  peer.emit("text", JSON.stringify({ type: "bridge-ack", ack: 2 }));
  peer.emit("text", JSON.stringify({ type: "bridge-replay-request", ack: 1 }));
  assert.equal(reason, "invalid reliable bridge replay acknowledgement");
});

test("reliable session replaces an active peer without starting grace disposal", async () => {
  const session = new ReliableSession({
    connectionId: "session-replace",
    serverEpoch: "epoch-1",
    buildId: "1.0",
    graceMs: 5,
  });
  const first = new FakePeer();
  const second = new FakePeer();
  session.attach(first);
  session.attach(second);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(first.closed, true);
  assert.equal(session.disposed, false);
  session.dispose();
});

test("reliable session disposes after the reconnection grace period", async () => {
  const session = new ReliableSession({
    connectionId: "session-4",
    serverEpoch: "epoch-1",
    buildId: "1.0",
    graceMs: 5,
  });
  const peer = new FakePeer();
  const disposed = new Promise((resolve) => session.once("dispose", resolve));
  session.attach(peer);
  peer.close();
  const keepEventLoopAlive = setTimeout(() => {}, 50);
  assert.equal(await disposed, "reconnection grace period expired");
  clearTimeout(keepEventLoopAlive);
});

test("reliable handshake resumes the existing server session", async () => {
  const sessions = new Map();
  let createCount = 0;
  const createSession = (connectionId) => {
    createCount += 1;
    const session = new ReliableSession({ connectionId, serverEpoch: "epoch-1", buildId: "1.0" });
    sessions.set(connectionId, session);
    session.once("dispose", () => sessions.delete(connectionId));
    return session;
  };
  const hello = {
    type: "bridge-hello",
    protocolVersion: 1,
    connectionId: "connection-resume",
    serverEpoch: null,
    buildId: "1.0",
  };
  const first = new FakePeer();
  const firstAccepted = acceptReliablePeer({
    peer: first,
    sessions,
    pendingSessions: new Map(),
    serverEpoch: "epoch-1",
    buildId: "1.0",
    allowUnknownBuild: false,
    createSession,
  });
  first.emit("text", JSON.stringify(hello));
  await firstAccepted;
  const session = sessions.get(hello.connectionId);
  session.send("unacknowledged");
  first.close();

  const second = new FakePeer();
  const secondAccepted = acceptReliablePeer({
    peer: second,
    sessions,
    pendingSessions: new Map(),
    serverEpoch: "epoch-1",
    buildId: "1.0",
    allowUnknownBuild: false,
    createSession,
  });
  second.emit("text", JSON.stringify({ ...hello, serverEpoch: "epoch-1" }));
  await secondAccepted;
  assert.equal(createCount, 1);
  assert.equal(second.frames.find((frame) => frame.type === "bridge-data").message, "unacknowledged");
  session.dispose();
});

test("reliable handshake rejects a stale build before creating a session", async () => {
  const peer = new FakePeer();
  let created = false;
  const accepted = acceptReliablePeer({
    peer,
    sessions: new Map(),
    pendingSessions: new Map(),
    serverEpoch: "epoch-1",
    buildId: "2.0",
    allowUnknownBuild: false,
    createSession: () => {
      created = true;
    },
  });
  peer.emit("text", JSON.stringify({
    type: "bridge-hello",
    protocolVersion: 1,
    connectionId: "connection-stale",
    serverEpoch: null,
    buildId: "1.0",
  }));
  await accepted;
  assert.equal(created, false);
  assert.equal(peer.frames[0].reason, "browser bundle version mismatch");
});

test("App Host handshake attaches before registration settles and retains its owner on disconnect", async () => {
  let owner;
  const primary = { isDestroyed: () => false, webContents: { id: 1 } };
  class BrowserWindow {
    constructor() {
      this.destroyed = false;
      this.webContents = new EventEmitter();
      owner = this;
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.destroyed = true;
      this.webContents.emit("destroyed");
    }

    static getAllWindows() {
      return [primary];
    }
  }
  const sessions = new Map();
  const pendingSessions = new Map();
  const peer = new FakePeer();
  const accepting = acceptReliablePeer({
    peer,
    sessions,
    pendingSessions,
    serverEpoch: "epoch-1",
    buildId: "1.0",
    allowUnknownBuild: false,
    createSession: (connectionId, signal) => createAppHostSession({
      electron: { BrowserWindow },
      getContext: () => ({ createAppHost: () => ({}), registerAppView: () => new Promise(() => {}) }),
      createRpc: () => ({}),
      connectionId,
      serverEpoch: "epoch-1",
      buildId: "1.0",
      sessions,
      signal,
    }),
  });
  peer.emit("text", JSON.stringify({
    type: "bridge-hello",
    protocolVersion: 1,
    connectionId: "pending-app-host",
    serverEpoch: null,
    buildId: "1.0",
  }));
  await new Promise((resolve) => setImmediate(resolve));
  peer.close();
  await accepting;
  assert.equal(owner.destroyed, false);
  assert.equal(pendingSessions.size, 0);
  assert.equal(sessions.size, 1);
  sessions.get("pending-app-host").dispose("test complete");
  assert.equal(owner.destroyed, true);
});

test("a new handshake replaces an aborted pending session with the same connection ID", async () => {
  const sessions = new Map();
  const pendingSessions = new Map();
  let createCount = 0;
  const createSession = (connectionId, signal) => {
    createCount += 1;
    if (createCount === 1) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted first creation")), { once: true });
      });
    }
    const session = new ReliableSession({ connectionId, serverEpoch: "epoch-1", buildId: "1.0" });
    sessions.set(connectionId, session);
    return session;
  };
  const hello = JSON.stringify({
    type: "bridge-hello",
    protocolVersion: 1,
    connectionId: "replace-aborted-pending",
    serverEpoch: null,
    buildId: "1.0",
  });
  const first = new FakePeer();
  const firstAccepting = acceptReliablePeer({
    peer: first,
    sessions,
    pendingSessions,
    serverEpoch: "epoch-1",
    buildId: "1.0",
    allowUnknownBuild: false,
    createSession,
  });
  first.emit("text", hello);
  await new Promise((resolve) => setImmediate(resolve));
  first.close();

  const second = new FakePeer();
  const secondAccepting = acceptReliablePeer({
    peer: second,
    sessions,
    pendingSessions,
    serverEpoch: "epoch-1",
    buildId: "1.0",
    allowUnknownBuild: false,
    createSession,
  });
  second.emit("text", hello);
  await Promise.all([firstAccepting, secondAccepting]);
  assert.equal(createCount, 2);
  assert.equal(second.frames.some((frame) => frame.type === "bridge-ready"), true);
  assert.equal(second.frames.some((frame) => frame.type === "bridge-reset"), false);
  sessions.get("replace-aborted-pending").dispose();
});

test("App Host session retains its distinct owner across a socket disconnect", async () => {
  let nextId = 10;
  const owners = [];
  const primary = { isDestroyed: () => false, webContents: { id: 1 } };
  class BrowserWindow {
    constructor() {
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.id = nextId++;
      owners.push(this);
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.destroyed = true;
      this.webContents.emit("destroyed");
    }

    static getAllWindows() {
      return [primary, ...owners];
    }
  }
  const registeredOwners = [];
  const context = {
    createAppHost: () => ({ service: true }),
    registerAppView: async (webContents) => registeredOwners.push(webContents.id),
  };
  const electron = { BrowserWindow };
  const sessions = new Map();
  const create = (connectionId) => createAppHostSession({
    electron,
    getContext: (webContents) => (webContents === primary.webContents ? context : null),
    createRpc: () => ({ rpc: true }),
    connectionId,
    serverEpoch: "epoch-1",
    buildId: "1.0",
    sessions,
  });
  const firstSession = await create("owner-session-1");
  const secondSession = await create("owner-session-2");
  assert.notEqual(owners[0].webContents.id, owners[1].webContents.id);
  assert.deepEqual(registeredOwners, [owners[0].webContents.id, owners[1].webContents.id]);
  const peer = new FakePeer();
  firstSession.attach(peer);
  peer.close();
  assert.equal(owners[0].destroyed, false);
  firstSession.dispose("test complete");
  assert.equal(owners[0].destroyed, true);
  owners[1].destroy();
  assert.equal(secondSession.disposed, true);
  assert.equal(sessions.has("owner-session-2"), false);
});

test("App Host initialization failure destroys its hidden owner", async () => {
  let owner;
  const primary = { isDestroyed: () => false, webContents: { id: 1 } };
  class BrowserWindow {
    constructor() {
      this.destroyed = false;
      this.webContents = new EventEmitter();
      owner = this;
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.destroyed = true;
      this.webContents.emit("destroyed");
    }

    static getAllWindows() {
      return [primary];
    }
  }
  const context = {
    createAppHost: () => {
      throw new Error("initialization failed");
    },
  };
  await assert.rejects(
    createAppHostSession({
      electron: { BrowserWindow },
      getContext: () => context,
      createRpc: () => {},
      connectionId: "failed-owner",
      serverEpoch: "epoch-1",
      buildId: "1.0",
      sessions: new Map(),
    }),
    /initialization failed/u,
  );
  assert.equal(owner.destroyed, true);
});

test("App Host registration cannot resurrect a session whose owner was destroyed", async () => {
  let owner;
  const primary = { isDestroyed: () => false, webContents: { id: 1 } };
  class BrowserWindow {
    constructor() {
      this.destroyed = false;
      this.webContents = new EventEmitter();
      owner = this;
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.emit("destroyed");
    }

    static getAllWindows() {
      return [primary];
    }
  }
  const registration = new Promise(() => {});
  const sessions = new Map();
  const session = await createAppHostSession({
    electron: { BrowserWindow },
    getContext: () => ({ createAppHost: () => ({}), registerAppView: () => registration }),
    createRpc: () => ({}),
    connectionId: "destroyed-during-registration",
    serverEpoch: "epoch-1",
    buildId: "1.0",
    sessions,
  });
  owner.destroy();
  assert.equal(session.disposed, true);
  assert.equal(sessions.size, 0);
});

test("masked WebSocket text frame becomes one opaque RPC message", () => {
  const socket = new FakeSocket();
  const peer = new WebSocketPeer(socket);
  const messages = [];
  peer.on("text", (data) => messages.push(data));
  socket.emit("data", maskedTextFrame('["push",1]'));
  assert.deepEqual(messages, ['["push",1]']);
});

test("upgrade head waits for the RPC port listener", async () => {
  const socket = new FakeSocket();
  const peer = new WebSocketPeer(socket, maskedTextFrame('["push",2]'));
  const messages = [];
  peer.on("text", (data) => messages.push(data));
  await Promise.resolve();
  assert.deepEqual(messages, ['["push",2]']);
});

test("RPC port emits one unmodified text frame", () => {
  const session = new ReliableSession({ connectionId: "rpc-port", serverEpoch: "epoch-1", buildId: "1.0" });
  const peer = new FakePeer();
  session.attach(peer);
  const port = new RpcMessagePort(session);
  port.postMessage('["pull",0]');
  assert.equal(peer.frames.at(-1).message, '["pull",0]');
  session.dispose();
});

test("RPC port rejects non-string frames", () => {
  const session = new EventEmitter();
  session.send = () => {};
  session.dispose = () => {};
  const port = new RpcMessagePort(session);
  assert.throws(() => port.postMessage({ method: "do-not-translate" }), /only supports string/u);
});

test("transferred port bridge retains its Electron port and replays across reconnect", () => {
  const port = new FakeMessagePort();
  const entry = {
    port,
    timeout: setTimeout(() => {}, 60_000),
    session: null,
    sessions: new Map(),
  };
  const session = createTransferredPortSession({
    entry,
    portId: "test-port",
    connectionId: "transferred-session",
    serverEpoch: "epoch-1",
    buildId: "1.0",
  });
  const first = new FakePeer();
  session.attach(first);
  first.emit("text", JSON.stringify({
    type: "bridge-data",
    id: 1,
    ack: 0,
    message: { type: "message", data: { from: "browser" } },
  }));
  port.emit("message", { data: { from: "electron" }, ports: [] });
  assert.deepEqual(port.messages, [{ from: "browser" }]);
  first.close();
  assert.equal(port.closed, false);
  const second = new FakePeer();
  session.attach(second);
  assert.deepEqual(
    second.frames.find((frame) => frame.type === "bridge-data").message,
    { type: "message", data: { from: "electron" } },
  );
  port.emit("close");
  assert.equal(second.frames.at(-1).type, "bridge-reset");
  assert.equal(second.frames.at(-1).reason, "Electron MessagePort closed");
  assert.equal(session.disposed, true);
  assert.equal(port.closed, true);
});
