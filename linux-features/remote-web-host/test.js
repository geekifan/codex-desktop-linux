"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  applyMainBundlePatch,
  applyRendererBundlePatch,
  applyExtractedWebviewCspPatch,
  applyWebviewCspPatch,
  buildBrowserPreload,
  findStartupSendSyncChannels,
  descriptors,
} = require("./patch.js");
const {
  RpcMessagePort,
  WebSocketPeer,
  attachTransferredPort,
  encodeFrame,
  websocketAccept,
} = require("./runtime/app-host-server.cjs");

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

test("feature remains optional and owns both transport patches", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.phase),
    ["main-bundle", "webview-asset", "extracted-app:pre-webview"],
  );
});

test("webview patch removes the browser-blocking CSP meta", () => {
  const source =
    '<head>\n  <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; connect-src &#39;self&#39;;">\n</head>';
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
  assert.doesNotMatch(
    fs.readFileSync(path.join(extractedDir, "webview", "index.html"), "utf8"),
    /Content-Security-Policy/u,
  );
  assert.match(
    fs.readFileSync(path.join(extractedDir, "webview", "assets", "codex-linux-remote-preload.js"), "utf8"),
    /__codexElectronShim/u,
  );
  fs.rmSync(extractedDir, { recursive: true });
});

test("browser preload preserves upstream bridge and snapshots startup sendSync calls", () => {
  const source =
    "let e=require(`electron`),a=`sync-a`,b=`sync-b`,x=e.ipcRenderer.sendSync(a),y=e.ipcRenderer.sendSync(b),z=e.ipcRenderer.sendSync(`sync-c`),j={x,y,z};";
  assert.deepEqual(findStartupSendSyncChannels(source), ["sync-a", "sync-b", "sync-c"]);
  const browserSource = buildBrowserPreload(source);
  assert.doesNotMatch(browserSource, /require\(`electron`\)/u);
  assert.match(browserSource, /globalThis\.__codexElectronShim/u);
  assert.match(browserSource, /\["sync-a","sync-b","sync-c"\]/u);
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
});

test("main patch adds one transparent server bootstrap", () => {
  const source = [
    "function u6(e,t,n){return new rpc.Connection(new d6(e),t,n).getRemoteMain()}",
    "function setup(){electron.ipcMain.on(channel,event=>{if(!trusted(event))return;let[port]=event.ports,context=getContext(event.sender),host=context?.createAppHost(event.sender),remote=u6(port,host);context?.registerAppView(event.sender,remote).catch(()=>console.warn(`Failed to register AppView RPC services`))})}",
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
  assert.match(patched, /BM\(codexLinuxRemoteWebSocketMessagePort/u);
  assert.equal(applyRendererBundlePatch(patched), patched);
});

test("WebSocket accept key follows RFC 6455", () => {
  assert.equal(
    websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});

test("masked WebSocket text frame becomes one opaque RPC message", () => {
  const socket = new FakeSocket();
  const peer = new WebSocketPeer(socket);
  const port = new RpcMessagePort(peer);
  const messages = [];
  port.on("message", (event) => messages.push(event.data));
  socket.emit("data", maskedTextFrame('["push",1]'));
  assert.deepEqual(messages, ['["push",1]']);
});

test("upgrade head waits for the RPC port listener", async () => {
  const socket = new FakeSocket();
  const peer = new WebSocketPeer(socket, maskedTextFrame('["push",2]'));
  const port = new RpcMessagePort(peer);
  const messages = [];
  port.on("message", (event) => messages.push(event.data));
  await Promise.resolve();
  assert.deepEqual(messages, ['["push",2]']);
});

test("RPC port emits one unmodified text frame", () => {
  const socket = new FakeSocket();
  const peer = new WebSocketPeer(socket);
  const port = new RpcMessagePort(peer);
  port.postMessage('["pull",0]');
  assert.deepEqual(socket.writes, [encodeFrame(0x1, '["pull",0]')]);
});

test("RPC port rejects non-string frames", () => {
  const port = new RpcMessagePort(new WebSocketPeer(new FakeSocket()));
  assert.throws(() => port.postMessage({ method: "do-not-translate" }), /only supports string/u);
});

test("transferred port bridge forwards opaque messages in both directions", () => {
  const port = new FakeMessagePort();
  const peer = new EventEmitter();
  peer.sent = [];
  peer.sendText = (value) => peer.sent.push(value);
  peer.close = () => peer.emit("close");
  attachTransferredPort({
    entry: { port, timeout: setTimeout(() => {}, 60_000) },
    portId: "test-port",
    peer,
  });
  peer.emit("text", JSON.stringify({ type: "message", data: { from: "browser" } }));
  port.emit("message", { data: { from: "electron" }, ports: [] });
  assert.deepEqual(port.messages, [{ from: "browser" }]);
  assert.deepEqual(JSON.parse(peer.sent[0]), { type: "message", data: { from: "electron" } });
  peer.emit("close");
  assert.equal(port.closed, true);
});
