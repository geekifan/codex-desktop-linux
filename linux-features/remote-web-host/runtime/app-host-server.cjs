"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const RELIABLE_PROTOCOL_VERSION = 1;
const DEFAULT_RECONNECT_GRACE_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_UNACKED_BYTES = 64 * 1024 * 1_024;
const DEFAULT_MAX_IN_FLIGHT_BYTES = 256 * 1024;
const KEEPALIVE_INTERVAL_MS = 5_000;
const SOCKET_TIMEOUT_MS = 20_000;

function websocketAccept(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  }
  if (body.length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

class WebSocketPeer extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0)) {
    super();
    this.socket = socket;
    this.buffer = head;
    this.closed = false;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
    if (head.length > 0) {
      queueMicrotask(() => this.drain());
    }
  }

  sendText(value) {
    if (this.closed) {
      throw new Error("Remote App Host WebSocket is closed");
    }
    this.socket.write(encodeFrame(0x1, Buffer.from(value, "utf8")));
  }

  close(code = 1000) {
    if (this.closed) {
      return;
    }
    const payload = Buffer.allocUnsafe(2);
    payload.writeUInt16BE(code);
    this.socket.end(encodeFrame(0x8, payload));
    this.finish();
  }

  finish() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }

  drain() {
    while (!this.closed) {
      if (this.buffer.length < 2) {
        return;
      }
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (!final || !masked) {
        this.close(1002);
        return;
      }
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const largeLength = this.buffer.readBigUInt64BE(2);
        if (largeLength > BigInt(MAX_FRAME_BYTES)) {
          this.close(1009);
          return;
        }
        length = Number(largeLength);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.close(1009);
        return;
      }
      if (this.buffer.length < offset + 4 + length) {
        return;
      }
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode !== 0x1) {
        this.close(1003);
        return;
      }
      this.emit("text", payload.toString("utf8"));
    }
  }
}

class ReliableSession extends EventEmitter {
  constructor(options) {
    super();
    this.connectionId = options.connectionId;
    this.serverEpoch = options.serverEpoch;
    this.buildId = options.buildId;
    this.graceMs = options.graceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.maxUnackedBytes = options.maxUnackedBytes ?? DEFAULT_MAX_UNACKED_BYTES;
    this.maxInFlightBytes = options.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES;
    this.peer = null;
    this.peerListeners = null;
    this.outgoingMessageId = 0;
    this.outgoingAckId = 0;
    this.outgoingSentId = 0;
    this.outgoingUnackedBytes = 0;
    this.outgoingUnacked = [];
    this.incomingMessageId = 0;
    this.disposed = false;
    this.graceTimer = null;
    this.keepaliveTimer = null;
    this.lastIncomingAt = Date.now();
  }

  attach(peer) {
    if (this.disposed || peer.closed === true) {
      peer.close(1012);
      return false;
    }
    this.clearGraceTimer();
    this.replacePeer(peer);
    this.lastIncomingAt = Date.now();
    const onText = (text) => {
      if (this.peer !== peer) return;
      this.lastIncomingAt = Date.now();
      this.receive(text);
    };
    const onClose = () => {
      if (this.peer !== peer) return;
      this.detachPeer(peer);
      this.startGraceTimer();
    };
    this.peerListeners = { onText, onClose };
    peer.on("text", onText);
    peer.on("close", onClose);
    const ready = this.write({
      type: "bridge-ready",
      protocolVersion: RELIABLE_PROTOCOL_VERSION,
      connectionId: this.connectionId,
      serverEpoch: this.serverEpoch,
      buildId: this.buildId,
    });
    if (!ready || this.peer !== peer || peer.closed === true) return false;
    if (!this.writeAck() || this.peer !== peer || peer.closed === true) return false;
    this.outgoingSentId = this.outgoingAckId;
    this.pumpOutgoing();
    if (this.peer !== peer || peer.closed === true) return false;
    this.startKeepalive();
    this.emit("attached");
    return true;
  }

  send(message) {
    if (this.disposed) return false;
    const serializedMessage = JSON.stringify(message);
    const byteLength = Buffer.byteLength(serializedMessage);
    const snapshot = JSON.parse(serializedMessage);
    const outgoing = { id: ++this.outgoingMessageId, message: snapshot, byteLength };
    this.outgoingUnacked.push(outgoing);
    this.outgoingUnackedBytes += byteLength;
    if (this.outgoingUnackedBytes > this.maxUnackedBytes) {
      this.reset("reliable bridge buffer exceeded");
      return false;
    }
    this.pumpOutgoing();
    return true;
  }

  receive(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.reset("invalid reliable bridge frame");
      return;
    }
    if (frame == null || typeof frame !== "object" || typeof frame.type !== "string") {
      this.reset("invalid reliable bridge frame");
      return;
    }
    if (frame.type === "bridge-data") {
      if (this.acceptAck(frame.ack)) this.acceptMessage(frame);
      return;
    }
    if (frame.type === "bridge-ack") {
      this.acceptAck(frame.ack);
      return;
    }
    if (frame.type === "bridge-replay-request") {
      if (frame.ack < this.outgoingAckId) {
        this.reset("invalid reliable bridge replay acknowledgement");
        return;
      }
      if (this.acceptAck(frame.ack, false)) {
        this.outgoingSentId = frame.ack;
        this.pumpOutgoing();
      }
      return;
    }
    if (frame.type === "bridge-keepalive") {
      return;
    }
    if (frame.type === "bridge-disconnect") {
      this.dispose("client disconnected");
      return;
    }
    this.reset("unsupported reliable bridge frame");
  }

  acceptMessage(frame) {
    if (!Number.isSafeInteger(frame.id) || frame.id <= 0) {
      this.reset("invalid reliable bridge message id");
      return;
    }
    if (frame.id === this.incomingMessageId + 1) {
      this.incomingMessageId = frame.id;
      try {
        this.emit("message", frame.message);
      } catch {
        this.reset("reliable bridge message handler failed");
        return;
      }
      this.writeAck();
      return;
    }
    if (frame.id <= this.incomingMessageId) {
      this.writeAck();
      return;
    }
    this.write({ type: "bridge-replay-request", ack: this.incomingMessageId });
  }

  acceptAck(ack, pump = true) {
    if (!Number.isSafeInteger(ack) || ack < 0 || ack > this.outgoingSentId) {
      this.reset("invalid reliable bridge acknowledgement");
      return false;
    }
    if (ack <= this.outgoingAckId) return true;
    this.outgoingAckId = ack;
    for (const message of this.outgoingUnacked) {
      if (message.id > ack) break;
      this.outgoingUnackedBytes -= message.byteLength;
    }
    this.outgoingUnacked = this.outgoingUnacked.filter((message) => message.id > ack);
    if (pump) this.pumpOutgoing();
    return true;
  }

  pumpOutgoing() {
    if (this.peer == null) return;
    let inFlightBytes = this.outgoingUnacked
      .filter((message) => message.id <= this.outgoingSentId)
      .reduce((total, message) => total + message.byteLength, 0);
    for (const message of this.outgoingUnacked) {
      if (message.id <= this.outgoingSentId) continue;
      if (inFlightBytes > 0 && inFlightBytes + message.byteLength > this.maxInFlightBytes) break;
      const written = this.write({
        type: "bridge-data",
        id: message.id,
        ack: this.incomingMessageId,
        message: message.message,
      });
      if (!written) break;
      this.outgoingSentId = message.id;
      inFlightBytes += message.byteLength;
    }
  }

  writeAck() {
    return this.write({ type: "bridge-ack", ack: this.incomingMessageId });
  }

  write(frame) {
    if (this.peer == null) return false;
    const peer = this.peer;
    try {
      peer.sendText(JSON.stringify(frame));
      return true;
    } catch {
      peer.close(1011);
      if (this.peer === peer) {
        this.detachPeer(peer);
        this.startGraceTimer();
      }
      return false;
    }
  }

  reset(reason) {
    this.write({ type: "bridge-reset", reason });
    this.dispose(reason);
  }

  replacePeer(peer) {
    const previous = this.peer;
    if (previous == null || previous === peer) {
      this.peer = peer;
      return;
    }
    this.detachPeer(previous);
    previous.close(1000);
    this.peer = peer;
  }

  detachPeer(peer) {
    if (this.peer !== peer) return;
    if (this.peerListeners != null) {
      peer.removeListener("text", this.peerListeners.onText);
      peer.removeListener("close", this.peerListeners.onClose);
    }
    this.peerListeners = null;
    this.peer = null;
    this.stopKeepalive();
  }

  startGraceTimer() {
    this.clearGraceTimer();
    this.graceTimer = setTimeout(() => this.dispose("reconnection grace period expired"), this.graceMs);
    this.graceTimer.unref?.();
  }

  clearGraceTimer() {
    if (this.graceTimer != null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (Date.now() - this.lastIncomingAt >= SOCKET_TIMEOUT_MS) {
        this.peer?.close(1001);
        return;
      }
      this.write({ type: "bridge-keepalive" });
    }, KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref?.();
  }

  stopKeepalive() {
    if (this.keepaliveTimer != null) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  dispose(reason = "disposed") {
    if (this.disposed) return;
    this.disposed = true;
    this.clearGraceTimer();
    this.stopKeepalive();
    const peer = this.peer;
    if (peer != null) this.detachPeer(peer);
    peer?.close(1000);
    this.outgoingUnacked = [];
    this.outgoingUnackedBytes = 0;
    this.emit("dispose", reason);
  }
}

class RpcMessagePort extends EventEmitter {
  constructor(session) {
    super();
    this.session = session;
    session.on("message", (data) => this.emit("message", { data }));
    session.on("dispose", () => this.emit("close"));
  }

  start() {}

  postMessage(data) {
    if (data == null) {
      this.close();
      return;
    }
    if (typeof data !== "string") {
      throw new TypeError("Remote App Host transport only supports string frames");
    }
    this.session.send(data);
  }

  close() {
    this.session.dispose("RPC transport closed");
  }
}

function findWindowContext(electron, getContext) {
  for (const window of electron.BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    const context = getContext(window.webContents);
    if (context != null) return context;
  }
  return null;
}

function reject(socket, status, message) {
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

async function createAppHostSession({
  electron,
  getContext,
  createRpc,
  connectionId,
  serverEpoch,
  buildId,
  sessions,
  signal,
}) {
  const context = findWindowContext(electron, getContext);
  if (context == null) {
    throw new Error("No initialized Codex window context is available");
  }
  if (signal?.aborted) {
    throw new Error("App Host initialization aborted");
  }
  const owner = new electron.BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: { backgroundThrottling: false },
  });
  const session = new ReliableSession({ connectionId, serverEpoch, buildId });
  const onOwnerDestroyed = () => session.dispose("App Host owner destroyed");
  owner.webContents.once("destroyed", onOwnerDestroyed);
  session.once("dispose", (reason) => {
    sessions.delete(connectionId);
    owner.webContents.removeListener("destroyed", onOwnerDestroyed);
    console.log(`[remote-web-host] App Host session disposed: ${reason}`);
    if (!owner.isDestroyed()) owner.destroy();
  });
  try {
    const port = new RpcMessagePort(session);
    const appHost = context.createAppHost(owner.webContents);
    const remoteAppView = createRpc(port, appHost);
    const registration = context.registerAppView(owner.webContents, remoteAppView);
    sessions.set(connectionId, session);
    Promise.resolve(registration).then(() => {
      if (session.disposed || owner.isDestroyed()) return;
      console.log(`[remote-web-host] App Host session registered: ${connectionId}`);
    }).catch((error) => {
      console.error("[remote-web-host] App Host registration failed", error);
      session.dispose("App Host registration failed");
    });
    return session;
  } catch (error) {
    session.dispose("App Host registration failed");
    throw error;
  }
}

const ipcRelays = new Map();
const transferablePorts = new Map();
let ipcRelayListenersInstalled = false;

function sendJson(peer, value) {
  if (typeof peer.send === "function") peer.send(value);
  else peer.sendText(JSON.stringify(value));
}

function installIpcRelayListeners(electron) {
  if (ipcRelayListenersInstalled) return;
  ipcRelayListenersInstalled = true;
  electron.ipcMain.on("codex-linux:remote-ipc-result", (event, result) => {
    const peer = ipcRelays.get(result.relayId);
    if (peer != null) sendJson(peer, { type: "result", ...result });
  });
  electron.ipcMain.on("codex-linux:remote-ipc-event", (event, message) => {
    const peer = ipcRelays.get(message.relayId);
    if (peer != null) sendJson(peer, { type: "event", ...message });
  });
  electron.ipcMain.on("codex-linux:remote-port-register", (event, registration) => {
    const port = event.ports[0];
    if (
      port == null ||
      registration == null ||
      typeof registration.portId !== "string" ||
      typeof registration.token !== "string" ||
      !ipcRelays.has(registration.relayId)
    ) {
      port?.close();
      return;
    }
    const timeout = setTimeout(() => {
      const entry = transferablePorts.get(registration.portId);
      if (entry?.port === port) transferablePorts.delete(registration.portId);
      port.close();
    }, 30_000);
    timeout.unref?.();
    transferablePorts.set(registration.portId, {
      port,
      relayId: registration.relayId,
      session: null,
      sessions: new Map(),
      pendingSessions: new Map(),
      timeout,
      token: registration.token,
    });
  });
}

function transferablePortEntry(url) {
  if (!url.pathname.startsWith("/message-port/")) return null;
  const portId = url.pathname.slice("/message-port/".length);
  const entry = transferablePorts.get(portId);
  if (entry == null) return null;
  const provided = Buffer.from(url.searchParams.get("token") ?? "");
  const expected = Buffer.from(entry.token);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  return { entry, portId };
}

function createTransferredPortSession({ entry, portId, connectionId, serverEpoch, buildId }) {
  if (entry.session != null && !entry.session.disposed) {
    throw new Error("Transferred MessagePort is already claimed");
  }
  clearTimeout(entry.timeout);
  const session = new ReliableSession({ connectionId, serverEpoch, buildId });
  entry.session = session;
  entry.sessions.set(connectionId, session);
  session.once("dispose", () => {
    entry.sessions.delete(connectionId);
    if (entry.session === session) {
      entry.session = null;
      if (transferablePorts.get(portId) === entry) transferablePorts.delete(portId);
      entry.port.close();
    }
  });
  session.on("message", (message) => {
    if (message?.type !== "message") {
      session.reset("invalid transferred MessagePort frame");
      return;
    }
    entry.port.postMessage(message.data);
  });
  entry.port.on("message", (event) => {
    if (event.ports?.length > 0) {
      session.reset("nested transferred MessagePorts are not supported");
      return;
    }
    sendJson(session, { type: "message", data: event.data });
  });
  entry.port.once("close", () => session.reset("Electron MessagePort closed"));
  entry.port.start();
  return session;
}

function createIpcRelaySession({ electron, getContext, connectionId, serverEpoch, buildId, sessions }) {
  installIpcRelayListeners(electron);
  const context = findWindowContext(electron, getContext);
  const owner = electron.BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && getContext(window.webContents) === context,
  );
  if (owner == null) {
    throw new Error("No initialized Codex window is available for IPC relay");
  }
  const relayId = connectionId;
  const session = new ReliableSession({ connectionId, serverEpoch, buildId });
  ipcRelays.set(relayId, session);
  sessions.set(connectionId, session);
  session.once("dispose", () => {
    ipcRelays.delete(relayId);
    sessions.delete(connectionId);
    for (const [portId, entry] of transferablePorts) {
      if (entry.relayId !== relayId) continue;
      if (entry.session != null) entry.session.dispose("owning IPC relay disposed");
      else {
        clearTimeout(entry.timeout);
        transferablePorts.delete(portId);
        entry.port.close();
      }
    }
    if (!owner.isDestroyed()) {
      owner.webContents.send("codex-linux:remote-ipc-command", { relayId, type: "dispose-relay" });
    }
  });
  session.on("message", (command) => {
    if (
      command == null ||
      typeof command !== "object" ||
      typeof command.requestId !== "string" ||
      !["send-sync", "invoke", "send", "subscribe", "unsubscribe"].includes(command.type)
    ) {
      session.reset("invalid remote IPC command");
      return;
    }
    owner.webContents.send("codex-linux:remote-ipc-command", { relayId, ...command });
  });
  sendJson(session, { type: "ready" });
  return session;
}

function parseReliableHello(text) {
  let hello;
  try {
    hello = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    hello == null ||
    hello.type !== "bridge-hello" ||
    hello.protocolVersion !== RELIABLE_PROTOCOL_VERSION ||
    typeof hello.connectionId !== "string" ||
    hello.connectionId.length < 8 ||
    hello.connectionId.length > 128 ||
    !(hello.serverEpoch === null || typeof hello.serverEpoch === "string") ||
    !(hello.buildId === null || typeof hello.buildId === "string")
  ) {
    return null;
  }
  return hello;
}

function resetPeer(peer, reason) {
  try {
    peer.sendText(JSON.stringify({ type: "bridge-reset", reason }));
  } finally {
    peer.close(1008);
  }
}

async function acceptReliablePeer({
  peer,
  sessions,
  pendingSessions,
  serverEpoch,
  buildId,
  allowUnknownBuild,
  createSession,
}) {
  const hello = await new Promise((resolve) => {
    const timeout = setTimeout(() => finish(null), 10_000);
    timeout.unref?.();
    const finish = (value) => {
      clearTimeout(timeout);
      peer.removeListener("text", onText);
      peer.removeListener("close", onClose);
      resolve(value);
    };
    const onText = (text) => finish(parseReliableHello(text));
    const onClose = () => finish(null);
    peer.once("text", onText);
    peer.once("close", onClose);
  });
  if (hello == null || peer.closed) {
    if (!peer.closed) resetPeer(peer, "invalid reliable bridge handshake");
    return;
  }
  if (hello.serverEpoch !== null && hello.serverEpoch !== serverEpoch) {
    resetPeer(peer, "backend restarted");
    return;
  }
  if ((!allowUnknownBuild || hello.buildId !== null) && hello.buildId !== buildId) {
    resetPeer(peer, "browser bundle version mismatch");
    return;
  }
  let session = sessions.get(hello.connectionId);
  if (session == null) {
    if (hello.serverEpoch !== null) {
      resetPeer(peer, "reconnection session expired");
      return;
    }
    let pending;
    try {
      pending = pendingSessions.get(hello.connectionId);
      if (pending == null) {
        const controller = new AbortController();
        pending = {
          controller,
          waiters: new Set(),
          promise: Promise.resolve().then(() => createSession(hello.connectionId, controller.signal)),
        };
        pendingSessions.set(hello.connectionId, pending);
      }
      pending.waiters.add(peer);
      const onPendingPeerClose = () => {
        pending.waiters.delete(peer);
        if (pending.waiters.size === 0) {
          if (pendingSessions.get(hello.connectionId) === pending) {
            pendingSessions.delete(hello.connectionId);
          }
          pending.controller.abort();
        }
      };
      peer.once("close", onPendingPeerClose);
      try {
        session = await pending.promise;
      } finally {
        peer.removeListener("close", onPendingPeerClose);
        pending.waiters.delete(peer);
      }
      if (pendingSessions.get(hello.connectionId) === pending) {
        pendingSessions.delete(hello.connectionId);
      }
    } catch (error) {
      if (pendingSessions.get(hello.connectionId) === pending) {
        pendingSessions.delete(hello.connectionId);
      }
      console.error("[remote-web-host] failed to create reliable session", error);
      if (!peer.closed) resetPeer(peer, "failed to create remote session");
      return;
    }
  }
  if (peer.closed) {
    if (session.peer == null) session.startGraceTimer();
    return;
  }
  session.attach(peer);
}

async function start({ electron, getContext, createRpc }) {
  const bind = "127.0.0.1";
  const port = 5177;
  const serverEpoch = crypto.randomUUID();
  const buildId = fs
    .readFileSync(path.join(electron.app.getAppPath(), ".codex-linux-remote-build-id"), "utf8")
    .trim();
  const appHostSessions = new Map();
  const pendingAppHostSessions = new Map();
  const ipcSessions = new Map();
  const pendingIpcSessions = new Map();

  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        appVersion: electron.app.getVersion(),
        protocolVersion: RELIABLE_PROTOCOL_VERSION,
        buildId,
        serverEpoch,
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    const key = request.headers["sec-websocket-key"];
    const transferredPortPath = url.pathname.startsWith("/message-port/");
    const transferredPort = transferablePortEntry(url);
    if (url.pathname !== "/app-host" && url.pathname !== "/electron-ipc" && !transferredPortPath) {
      reject(socket, "404 Not Found", "Not found");
      return;
    }
    if (request.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
      reject(socket, "400 Bad Request", "Invalid WebSocket upgrade");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
    );
    const peer = new WebSocketPeer(socket, head);
    if (transferredPortPath && transferredPort == null) {
      peer.sendText(JSON.stringify({ type: "bridge-reset", reason: "transferred MessagePort unavailable" }));
      peer.close(1008);
      return;
    }
    if (transferredPort != null) {
      const { entry, portId } = transferredPort;
      acceptReliablePeer({
        peer,
        sessions: entry.sessions,
        pendingSessions: entry.pendingSessions,
        serverEpoch,
        buildId,
        allowUnknownBuild: false,
        createSession: (connectionId) =>
          createTransferredPortSession({ entry, portId, connectionId, serverEpoch, buildId }),
      });
      return;
    }
    if (url.pathname === "/electron-ipc") {
      acceptReliablePeer({
        peer,
        sessions: ipcSessions,
        pendingSessions: pendingIpcSessions,
        serverEpoch,
        buildId,
        allowUnknownBuild: false,
        createSession: (connectionId) =>
          createIpcRelaySession({ electron, getContext, connectionId, serverEpoch, buildId, sessions: ipcSessions }),
      });
      return;
    }
    acceptReliablePeer({
      peer,
      sessions: appHostSessions,
      pendingSessions: pendingAppHostSessions,
      serverEpoch,
      buildId,
      allowUnknownBuild: false,
      createSession: (connectionId, signal) =>
        createAppHostSession({
          electron,
          getContext,
          createRpc,
          connectionId,
          serverEpoch,
          buildId,
          sessions: appHostSessions,
          signal,
        }),
    }).catch((error) => {
      console.error("[remote-web-host] App Host reliable connection failed", error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, resolve);
  });
  console.log(`[remote-web-host] App Host WebSocket listening on ws://${bind}:${port}/app-host`);
  return server;
}

module.exports = {
  MAX_FRAME_BYTES,
  RELIABLE_PROTOCOL_VERSION,
  ReliableSession,
  RpcMessagePort,
  WebSocketPeer,
  acceptReliablePeer,
  createTransferredPortSession,
  createAppHostSession,
  createIpcRelaySession,
  encodeFrame,
  start,
  websocketAccept,
};
